#!/bin/sh
# job-heartbeat.sh — wrap a scheduled job so it CANNOT run without leaving proof, and CANNOT fail quietly.
#
# WHY (2026-07-13): every scheduled job on this machine was trusted to report on itself, and they
# didn't. launchd's own exit status is useless as proof — a job that has NEVER RUN reports exit 0,
# identical to one that ran and succeeded. That ambiguity let com.ruvnet.brain-nightly sit unfired
# and look healthy. Per-job good intentions rot; a wrapper cannot forget.
#
# WHY THE WRAPPER, NOT THE CHILD, WRITES THE TERMINAL RECORD (2026-09-11 review correction): a
# SIGKILLed child cannot write its own outcome — no handler runs, by definition. So this script never
# asks the wrapped command to self-report; the WRAPPER is the supervisor. It writes "running" before
# the child starts, watches it via `wait`, and derives the terminal record (ok / failed / killed)
# from the child's OWN wait status — the one piece of truth a dying child cannot fake or withhold.
#
# Usage (from a LaunchAgent's ProgramArguments):
#   /bin/sh /path/to/job-heartbeat.sh <label> -- <command> [args...]
#
# Guarantees:
#   1. A "start" receipt is written BEFORE the command runs, carrying a `run_id` unique to THIS
#      invocation (pid + start-epoch). A second, concurrent invocation for the same label gets its
#      own run_id and overwrites the "running" record with its own — see the STALE WRITER GUARD
#      below for what that means for the terminal write.
#   2. A terminal receipt is written even if the command dies, is killed, or the machine yanks it
#      away — the trap fires on EXIT/INT/TERM. Its `state` is one of:
#        ok      — exited zero.
#        failed  — exited non-zero, NOT via a signal (POSIX: an exit code in 1..128).
#        killed  — died to a signal (POSIX: `wait` reports 128+signal for a signal-killed child, and
#                  the two in-wrapper traps below reuse that exact convention for TERM/INT delivered
#                  to the WRAPPER itself). The signal number is carried as `"signal"`.
#      SIGKILL (-9) of the WRAPPER itself is the one death nothing here can catch — no handler runs,
#      the receipt is left stuck at "running" with its run_id, and that is deliberately NOT
#      "fixed" here: scripts/nightly-watchdog.mjs already derives FAILING from a stale receipt whose
#      pid no longer exists (see its `judge()` — this is the "started and never finished" case,
#      because a run_id can never reach a terminal state if nothing survived to write one).
#   3. STALE WRITER GUARD: before writing the terminal record, the wrapper re-reads the on-disk
#      receipt's run_id. If some OTHER, newer invocation has since overwritten it (a different
#      run_id — meaning a fresh "running" record was written after this one), this process's
#      terminal write is REFUSED. An old, dying writer must never clobber a newer run's evidence
#      with its own stale outcome; the newer run owns the receipt and will write its own terminal
#      record when it finishes.
#   4. A non-zero exit pushes an URGENT ntfy alert immediately (topic: $NTFY_TOPIC, or the file
#      ~/.cache/ruvnet-brain/ntfy-topic). No topic = no push, but the receipt is still written.
#   5. The wrapper's own exit code is the job's exit code — launchd still sees the truth.

set -u

LABEL="${1:?usage: job-heartbeat.sh <label> -- <command...>}"
shift
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "job-heartbeat: no command given for $LABEL" >&2; exit 2; }

HB_DIR="${JOB_HEARTBEAT_DIR:-$HOME/.cache/ruvnet-brain/heartbeats}"
mkdir -p "$HB_DIR"
HB="$HB_DIR/$LABEL.json"

# Atomic write: tmp file (same filesystem) + rename. `cat > "$HB"` directly would let a concurrent
# reader (nightly-watchdog.mjs, or another job-heartbeat.sh instance's stale-writer check) observe a
# half-written file mid-write and fail to parse it — a real, if rare, race under load. `mv` on the
# same filesystem is a single rename() syscall: readers see either the old content or the new, never
# a partial file.
write_receipt() { # write_receipt <content>
  tmp="$HB.tmp-$$"
  printf '%s' "$1" > "$tmp" && mv -f "$tmp" "$HB"
}

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
STARTED="$(ts)"
START_EPOCH="$(date +%s)"
# RUN_ID: pid + start-epoch-second. Unique enough to tell "this invocation" apart from any other
# invocation of the SAME label that might be alive at the same time — a second's collision would
# also require a recycled pid inside that same second, which the OS does not do.
RUN_ID="$$-$START_EPOCH"

# F3 (2026-07-18): remember the receipt as it was BEFORE this fire. A skip-fire (exit 75, the
# reserved "another instance is already running" code) must not destroy the live run's evidence —
# its finish() RESTORES this snapshot instead of overwriting the receipt with a meaningless "ok/0s".
# Without this, a skip stamped state:"ok" over a real run's "running", and if that real run was then
# SIGKILLed, the watchdog's started-and-never-finished detection had nothing left to see.
PREV_HB=""
[ -f "$HB" ] && PREV_HB="$(cat "$HB" 2>/dev/null)"

# Start receipt. If the job vanishes without ever writing an end receipt, THIS is the evidence that
# it started and never finished — a state the watchdog reports as FAILING, not as silence.
write_receipt "{\"label\":\"$LABEL\",\"started_at\":\"$STARTED\",\"state\":\"running\",\"pid\":$$,\"run_id\":\"$RUN_ID\",\"command\":\"$(printf '%s %s' "$1" "${2:-}" | tr -d '"\\\n\r' | cut -c1-200)\"}"

notify() { # notify <title> <body> <priority>
  # NTFY_TOPIC set-but-EMPTY is an explicit opt-out (2026-07-18): unit tests wrap this script around
  # deliberately-failing fixture commands (t-fail, t.bad, exit 7), and the topic-file fallback below
  # meant every test run PAGED Stuart's real phone — 16+ fixture pages in one morning, indistinguishable
  # from real job failures. Tests set NTFY_TOPIC="" and stay silent; production (unset) still falls
  # through to the topic file.
  if [ "${NTFY_TOPIC+set}" = "set" ] && [ -z "$NTFY_TOPIC" ]; then return 0; fi
  topic="${NTFY_TOPIC:-}"
  [ -z "$topic" ] && [ -f "$HOME/.cache/ruvnet-brain/ntfy-topic" ] && topic="$(cat "$HOME/.cache/ruvnet-brain/ntfy-topic")"
  [ -z "$topic" ] && return 1
  # --fail: an HTTP error is a failed delivery. The caller records whether the page landed, so a page that
  # never arrived is retried on the next run instead of muting the whole failing streak (review 2026-10-25).
  curl -sS --fail -m 10 -H "Title: $1" -H "Priority: $3" -H "Tags: ${4:-rotating_light}" -d "$2" "https://ntfy.sh/$topic" >/dev/null 2>&1
}

# The run_id currently on disk for this label, or empty if the receipt is missing/unreadable/has
# none (an old receipt written before this field existed). No jq dependency — one anchored sed.
current_run_id() {
  sed -n 's/.*"run_id":"\([^"]*\)".*/\1/p' "$HB" 2>/dev/null | head -1
}

finish() {
  code=${FORCED_CODE:-$?}
  # Stop the run-time timer FIRST, on every exit path (skip, stale writer, normal), so it can never outlive
  # this wrapper (Opus review 2026-10-25).
  [ -n "${TIMER:-}" ] && kill "$TIMER" 2>/dev/null
  timed_out=0
  if [ -f "$HB.timeout-$RUN_ID" ]; then
    # Finish the KILL phase on the recorded tree: the child may have exited on TERM while descendants linger.
    timed_out=1; sleep 1; kill -KILL $(cat "$HB.timeout-$RUN_ID") 2>/dev/null; rm -f "$HB.timeout-$RUN_ID"
  fi
  ended="$(ts)"
  dur=$(( $(date +%s) - START_EPOCH ))
  # Exit 75 = SKIP (lock held by a live run). Restore the pre-fire receipt so the live run's evidence
  # survives; report 0 to launchd (a skip is not a failure). If no receipt ever existed, record an
  # honest "skipped" — which the watchdog treats as NOT proof of a real run.
  if [ "$code" -eq 75 ]; then
    if [ -n "$PREV_HB" ]; then write_receipt "$PREV_HB"; else
      write_receipt "$(printf '{"label":"%s","started_at":"%s","ended_at":"%s","state":"skipped","duration_sec":%s,"run_id":"%s"}' "$LABEL" "$STARTED" "$ended" "$dur" "$RUN_ID")"
    fi
    exit 0
  fi
  # STALE WRITER GUARD: a newer invocation for this same label may have already taken the receipt
  # over (its own "running" record carries a DIFFERENT run_id). If so, this process's outcome is
  # stale — it must not overwrite evidence that belongs to a run that is still, or already, ahead of
  # it. Say so on stderr (so it is not a silent no-op) and exit with the real code regardless.
  ON_DISK_RUN_ID="$(current_run_id)"
  if [ -n "$ON_DISK_RUN_ID" ] && [ "$ON_DISK_RUN_ID" != "$RUN_ID" ]; then
    echo "job-heartbeat: $LABEL receipt now belongs to run $ON_DISK_RUN_ID — not overwriting it with stale run $RUN_ID (exit $code)" >&2
    exit "$code"
  fi
  # Derive ok / failed / killed from the CHILD'S OWN wait status, never from anything the child said
  # about itself. POSIX: a process terminated by signal N is reported by `wait`/`$?` as 128+N — the
  # same convention this wrapper's own TERM/INT traps below use when THEY are what killed the child.
  # A job that was stopped for running too long is "killed" however it chose to exit on TERM.
  [ "$timed_out" -eq 1 ] && [ "$code" -le 128 ] && code=143
  if [ "$code" -eq 0 ]; then
    state="ok"; extra=""
  elif [ "$code" -gt 128 ]; then
    sig=$((code - 128))
    state="killed"; extra=",\"signal\":$sig"
    [ "$timed_out" -eq 1 ] && extra="$extra,\"timed_out_after_sec\":$MAX_SECONDS"
  else
    state="failed"; extra=""
  fi
  # PAGE ON THE TRANSITION, NOT ON EVERY RUN (owner, 2026-10-25: 10,747 notifications on one topic). A job that
  # starts failing pages once, urgently, while it is still tonight's problem; while it KEEPS failing it stays
  # quiet (failing_since carries the first failure; the nightly watchdog's digest still lists it); the run
  # that passes again sends one low-priority "recovered" note. The previous run's state comes from PREV_HB.
  prev_state="$(printf '%s' "$PREV_HB" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p' | head -1)"
  prev_since="$(printf '%s' "$PREV_HB" | sed -n 's/.*"failing_since":"\([^"]*\)".*/\1/p' | head -1)"
  was_failing=0; case "$prev_state" in failed|killed) was_failing=1 ;; esac
  # A failing streak counts as already paged only if that page was delivered ("paged":false = retry it).
  prev_unpaged=0; case "$PREV_HB" in *'"paged":false'*) prev_unpaged=1 ;; esac
  since=""
  if [ "$code" -ne 0 ]; then
    if [ "$was_failing" -eq 1 ] && [ -n "$prev_since" ]; then since="$prev_since"; else since="$STARTED"; fi
    extra="$extra,\"failing_since\":\"$since\""
  fi
  if [ "$code" -ne 0 ] && { [ "$was_failing" -eq 0 ] || [ "$prev_unpaged" -eq 1 ]; }; then
    reason="exit $code after ${dur}s"; [ "$timed_out" -eq 1 ] && reason="stopped after running past its ${MAX_SECONDS}s limit"
    if notify "🔴 SCHEDULED JOB FAILED: $LABEL" "$reason — see the job's log. Receipt: $HB. Further failures stay quiet until it recovers." "urgent"; then
      extra="$extra,\"paged\":true"; else extra="$extra,\"paged\":false"; fi
  elif [ "$code" -ne 0 ]; then
    extra="$extra,\"paged\":true"
  elif [ "$was_failing" -eq 1 ]; then
    notify "✅ Recovered: $LABEL" "passed again after failing since ${prev_since:-an earlier run}" "low" "white_check_mark" || true
  fi
  write_receipt "{\"label\":\"$LABEL\",\"started_at\":\"$STARTED\",\"ended_at\":\"$ended\",\"state\":\"$state\",\"exit_code\":$code,\"duration_sec\":$dur,\"run_id\":\"$RUN_ID\"$extra}"
  exit "$code"
}
trap finish EXIT
# A signal handler must KILL THE CHILD, then exit — letting the EXIT trap write the receipt once.
# The exit codes (143 = 128+15 TERM, 130 = 128+2 INT) intentionally reuse the same 128+signal
# convention `wait` uses for a directly-signalled child, so finish() classifies BOTH as "killed"
# with the right signal number, whether the signal reached the child directly or via this wrapper.
trap 'FORCED_CODE=143; [ -n "${TIMER:-}" ] && kill "$TIMER" 2>/dev/null; kill -TERM "$CHILD" 2>/dev/null; exit 143' TERM
trap 'FORCED_CODE=130; [ -n "${TIMER:-}" ] && kill "$TIMER" 2>/dev/null; kill -TERM "$CHILD" 2>/dev/null; exit 130' INT

# Run the job in the BACKGROUND and `wait` for it — do NOT run it in the foreground.
# Break-test finding (2026-07-13): a POSIX shell blocked on a FOREGROUND child does not run its trap
# when signalled — it dies with the receipt still saying "running", which is precisely the silent
# death this wrapper exists to prevent. `wait` is interruptible, so the trap fires immediately.
# The one death nothing can catch is SIGKILL (-9) / power loss, by definition: no handler runs. That
# case is caught one level up — nightly-watchdog.mjs reports a receipt stuck in "running" as FAILING
# ("started and never finished"). Trap for catchable deaths, watchdog for uncatchable ones.
"$@" &
CHILD=$!
# RUN-TIME LIMIT (2026-10-25: five jobs finished their work and then never exited, each holding its own
# next run off for 7-9 hours). After JOB_MAX_SECONDS (default 2 h; a plist may set less) the job is
# stopped: TERM, then KILL 10 s later. It is recorded as killed and pages once like any other failure.
descendants() { # every live descendant PID of $1 (portable: ps + awk)
  for k in $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$1" '$2==p {print $1}'); do printf '%s ' "$k"; descendants "$k"; done
}
MAX_SECONDS="${JOB_MAX_SECONDS:-7200}"
WRAPPER_PID=$$
case "$MAX_SECONDS" in ''|*[!0-9]*) MAX_SECONDS=7200 ;; esac
(
  sleep "$MAX_SECONDS" & SLEEPER=$!
  trap 'kill "$SLEEPER" 2>/dev/null; exit 0' TERM
  wait "$SLEEPER"
  # Only ever signal OUR child: still alive and still parented by this wrapper. If the wrapper died (the child
  # is reparented) or the PID was reused, do nothing.
  [ "$(ps -o ppid= -p "$CHILD" 2>/dev/null | tr -d ' ')" = "$WRAPPER_PID" ] || exit 0
  # The whole descendant tree goes, or a grandchild keeps the job's log pipe (and its work) alive. The tree
  # is recorded in the marker so finish() can complete the KILL phase even if the child exits on TERM.
  tree="$(descendants "$CHILD") $CHILD"
  printf '%s\n' $tree > "$HB.timeout-$RUN_ID"
  kill -TERM $tree 2>/dev/null; sleep 10
  kill -KILL $tree $(descendants "$CHILD") 2>/dev/null
) &
TIMER=$!
wait "$CHILD"
