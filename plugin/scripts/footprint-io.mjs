// footprint-io.mjs — the footprint sweep's disk operations (ADR-0098), kept apart from the classifier in
// brain-footprint.mjs: byte counts, log rotation, the guarded removal, the rescue of a released copy's
// operational files, and the KEPT-proof cache.
//
// THE KEPT-PROOF CACHE (independent review S7).
// kbCopyProof hashes every file of a GB-sized copy. A copy kept because it holds data the live brain lacks
// used to be re-hashed by every 6-hourly SessionStart sweep, forever, and was reported with "Fix: --clean",
// which can only keep it again. Only KEPT results are cached, keyed by a cheap stat fingerprint of the copy
// and of the live brain (no hashing, no tree walk); a stale entry can only KEEP a copy, never remove one, and
// any change to the live brain's identity files (a restore, an update) invalidates it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const lstat = (file) => { try { return fs.lstatSync(file); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

/**
 * macOS VOLUME METADATA: AppleDouble `._*` shadows (written beside every file on an exFAT/FAT disk, where a
 * `--move-brain` target may live), .DS_Store, and the volume's own .fseventsd / .Spotlight-V100 / .Trashes
 * / .TemporaryItems. They belong to the volume, never to the Brain: the classifier does not see them (never
 * cruft, never removed on their own) and the copy proof does not count them as a copy's unique data.
 */
export const isVolumeMetadata = (name) => /^\._|^\.DS_Store$|^\.fseventsd$|^\.Spotlight-V100$|^\.Trashes$|^\.TemporaryItems$|^\.apdisk$/.test(String(name));
/** Same rule as kb/refresh-run.mjs physicalPath: real path, or resolved through the parent when absent. */
export function physical(dir) {
  const resolved = path.resolve(String(dir || ''));
  try { return fs.realpathSync.native(resolved); } catch { /* absent */ }
  try { return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)); } catch { return resolved; }
}

/** A process is gone only when the OS says so (ESRCH); anything else counts as alive. */
export const pidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
};
const semver = (v) => String(v || '').replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
export const cmpVersion = (a, b) => {
  const A = semver(a); const B = semver(b);
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    const x = A[i] ?? 0; const y = B[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
};

/**
 * Leftovers of an INTERRUPTED `--move-brain`, by the names scripts/move-brain.mjs gives them: the original set
 * aside mid-swap (`<home>.old-<pid>`), staging copies (`.<name>.moving-<pid>` beside the home, or beside the
 * linked target on its disk) and links (`<home>.link-<pid>`, `<home>.link-old-<pid>`). Only a DEAD pid's — a
 * live one is a move still running.
 */
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WHAT = { old: 'the original Brain set aside by an interrupted move', 'link-old': 'a link left by an interrupted move',
  link: 'a link left by an interrupted move', moving: 'the staging copy of an interrupted move' };
export function findMoveLeftovers({ brainHome, location = null, isAlive = pidAlive }) {
  const base = path.basename(brainHome);
  const found = new Map();
  const scan = (dir, re) => {
    for (const name of names(dir)) {
      const m = re.exec(name);
      if (!m || isAlive(Number(m.at(-1)))) continue;
      const what = m.length > 2 ? m[1] : 'moving';
      found.set(path.join(dir, name), { path: path.join(dir, name), dir, what, pid: Number(m.at(-1)), reason: WHAT[what] });
    }
  };
  scan(path.dirname(brainHome), new RegExp(`^${escapeRe(base)}\\.(old|link-old|link)-(\\d+)$`));
  scan(path.dirname(brainHome), new RegExp(`^\\.${escapeRe(base)}\\.moving-(\\d+)$`));
  if (location?.state === 'linked' && location.real) scan(path.dirname(location.real), new RegExp(`^\\.${escapeRe(path.basename(location.real))}\\.moving-(\\d+)$`));
  return [...found.values()];
}

// ── the advice for each leftover: commands SAFE TO PASTE (re-review a6) ─────────────────────────
// An unquoted `rm -rf ${path}` on a volume named 'Backup 1' ran `rm -rf …/Backup` — another drive. Every path is
// quoted (POSIX single quotes; cmd double quotes on Windows), every command ends option parsing (`--`), and a
// destructive command is emitted only for a path whose real parent is the directory it was found in and which
// has no control character (or, on Windows, no double quote); otherwise the advice is to inspect it by hand.
const shQuote = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;
const COMMANDS = {
  posix: { rmTree: (p) => `rm -rf -- ${shQuote(p)}`, rmLink: (p) => `rm -- ${shQuote(p)}`, mv: (a, b) => `mv -- ${shQuote(a)} ${shQuote(b)}`, rmdir: (p) => `rmdir -- ${shQuote(p)}` },
  win32: { rmTree: (p) => `rmdir /s /q "${p}"`, rmLink: (p) => `rmdir "${p}"`, mv: (a, b) => `move "${a}" "${b}"`, rmdir: (p) => `rmdir "${p}"` },
};
const holdsBrain = (dir) => ['SOURCE.json', path.join('kb', 'SOURCE.json')].some((f) => Boolean(lstat(path.join(dir, f))));

/**
 * Assess every interrupted-move leftover. With the Brain's own path MISSING, each one is checked for a Brain it
 * holds (old-N, moving-N) or points at (link-old-N, link-N with a live target): the first such, in that order
 * of trust, is the one to RESTORE at the Brain path (✗, `mv`), and nothing else gets a delete — following an
 * rm or a fresh install there would orphan the private Brain (re-review a6 SHOULD-FIX 1).
 */
export function assessMoveLeftovers({ brainHome, location = null, isAlive = pidAlive, platform = process.platform }) {
  const cmd = COMMANDS[platform === 'win32' ? 'win32' : 'posix'];
  const safe = (p, dir) => physical(path.dirname(p)) === physical(dir) && !/[\u0000-\u001f\u007f]/.test(p)
    && !(platform === 'win32' && p.includes('"')) && !/[\u0000-\u001f\u007f]/.test(brainHome);
  const inspect = (p) => `inspect it by hand: ${JSON.stringify(p)} (no command is suggested for this path)`;
  // A real directory with no Brain in it counts as missing: a hook or the search server recreates the home on a
  // failure path (health.json, a notice file) after an interrupted move (4.5.2). A link is judged by `location`.
  const homeSt = lstat(brainHome);
  const homeMissing = !homeSt || (!homeSt.isSymbolicLink() && !holdsBrain(brainHome));
  const homeEmpty = Boolean(homeSt) && homeMissing && !names(brainHome).length;
  const found = findMoveLeftovers({ brainHome, location, isAlive }).map((lo) => {
    const link = Boolean(lstat(lo.path)?.isSymbolicLink());
    let target = null;
    if (link) { try { target = fs.realpathSync(lo.path); } catch { /* dangling */ } }
    return { ...lo, link, brain: link ? Boolean(target && holdsBrain(target)) : holdsBrain(lo.path) };
  });
  const order = ['old', 'link-old', 'link', 'moving'];
  const restore = homeMissing ? found.filter((f) => f.brain).sort((a, b) => order.indexOf(a.what) - order.indexOf(b.what))[0] : null;
  return found.map((f) => {
    const ok = safe(f.path, f.dir);
    // The recreated home is cleared out of the way first: removed if empty (rmdir refuses anything else), set aside
    // under a name of its own otherwise — never deleted with its contents, and the leftover is never deleted.
    const clear = !homeSt ? null : homeEmpty ? cmd.rmdir(brainHome) : cmd.mv(brainHome, `${brainHome}.recreated-${f.pid}`);
    if (f === restore) return { ...f, onlyCopy: true, fix: ok ? [clear, cmd.mv(f.path, brainHome)].filter(Boolean).join(' && ') : inspect(f.path) };
    if (restore) return { ...f, onlyCopy: false, fix: `keep it until the Brain is restored at ${JSON.stringify(brainHome)} and --doctor is green` };
    return { ...f, onlyCopy: false, fix: ok ? (f.link ? cmd.rmLink(f.path) : cmd.rmTree(f.path)) : inspect(f.path) };
  });
}

/** Bytes under a path, never following a link (a link counts as itself). */
export function treeBytes(target) {
  const st = lstat(target);
  if (!st) return 0;
  if (!st.isDirectory() || st.isSymbolicLink()) return st.size;
  let total = 0;
  for (const name of names(target)) total += treeBytes(path.join(target, name));
  return total;
}

/** Atomic rename-rotation: <name> -> <name>.1 (replacing the previous .1). Appenders reopen by path. */
export function rotate(file) { fs.renameSync(file, `${file}.1`); }
export function truncateToTail(file, keep) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(keep, size));
  try { fs.readSync(fd, buf, 0, buf.length, size - buf.length); } finally { fs.closeSync(fd); }
  const nl = buf.indexOf(10);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, nl >= 0 ? buf.subarray(nl + 1) : buf);
  fs.renameSync(tmp, file);
}

/**
 * Remove one entry that sits DIRECTLY inside the real directory it was inventoried in, and that directory is
 * an owned root or inside one, all real-path resolved. The old guard compared a path with its own parent
 * and could never refuse (review S7); now a directory swapped for a link between inventory and removal, or
 * any root outside the Brain's own, is refused. fs.rm removes a link itself, never its target.
 */
export function removeWithin(target, expectedParent, owned) {
  const st = lstat(target);
  if (!st) return 0;
  const realParent = physical(path.dirname(target));
  const realOk = realParent === expectedParent && owned.some((o) => realParent === o || realParent.startsWith(`${o}${path.sep}`));
  if (!realOk) throw new Error(`refusing to remove ${target}: its directory resolves to ${realParent}, not the owned root it was found in (${expectedParent})`);
  const size = treeBytes(target);
  fs.rmSync(target, { recursive: true, force: true });
  return size;
}

/**
 * RESCUE BEFORE RELEASE. kbCopyProof lists a disposable copy's operational files (logs, ruflo scratch) as
 * `rescue`, each with the bytes it was proven with. They are copied to <brainHome>/kb-copy-rescued/<copy
 * name>/<path> and verified there BEFORE the copy is removed. Any mismatch (the source changed since the
 * proof, a different file already at the destination, a link in the way) throws, and the caller keeps the
 * copy. Retention of the rescued directories is brain-footprint.mjs's (FOOTPRINT_POLICY.rescuedCopiesKept).
 */
export const RESCUE_DIR = 'kb-copy-rescued';
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const regular = (file) => { const st = lstat(file); return Boolean(st && st.isFile() && !st.isSymbolicLink()); };
export function rescueOperationalFiles(copyDir, rescue, brainHome, name = path.basename(copyDir)) {
  if (!rescue?.length) return null;
  const root = path.join(brainHome, RESCUE_DIR); const dest = path.join(root, name);
  for (const dir of [brainHome, root, dest]) {
    if (lstat(dir)?.isSymbolicLink()) throw new Error(`refusing to rescue into ${dir}: it is a link`);
  }
  for (const { file, sha256 } of rescue) {
    const from = path.join(copyDir, file); const to = path.join(dest, file);
    if (!regular(from) || sha256Of(from) !== sha256) throw new Error(`${file} changed after the copy was proven; the copy is kept`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!lstat(to)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    if (!regular(to) || sha256Of(to) !== sha256) throw new Error(`could not rescue ${file} to ${to} (a different file is there); the copy is kept`);
  }
  return dest;
}

const PROOF_CACHE = '.footprint-proof-cache.json';
// #335: schema 1 KEPT proofs predate kept-sibling accounting (two identical preserved copies each kept the
// other forever); they are proven once more. A dropped cache entry can only cost a re-hash, never a byte.
const PROOF_CACHE_SCHEMA = 2;
// The proof rule a cached KEPT verdict was reached under. A verdict from an older rule (one that kept copies
// the current rule releases, e.g. for a log file before rescue existed) is not reused; that copy is proven again.
const PROOF_RULE = 2;
const IDENTITY_FILES = ['SOURCE.json', 'PRIVATE-STORES.json', 'COVERAGE.json', 'RVF-GENERATIONS.json'];
const statKey = (file) => { try { const st = fs.lstatSync(file); return `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { return '-'; } };
const fingerprint = (dir) => [statKey(dir), ...IDENTITY_FILES.map((f) => statKey(path.join(dir, f)))].join('|');

export function readProofCache(brainHome) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(brainHome, PROOF_CACHE), 'utf8'));
    if (doc && doc.schemaVersion === PROOF_CACHE_SCHEMA && typeof doc.entries === 'object' && doc.entries) return doc;
  } catch { /* none yet */ }
  return { schemaVersion: PROOF_CACHE_SCHEMA, entries: {} };
}

/** The cached KEPT proof for this copy, if neither the copy nor the live brain changed since. */
export function cachedKept(cache, copyDir, liveDir) {
  const hit = cache.entries[copyDir];
  return hit && hit.rule === PROOF_RULE && hit.copy === fingerprint(copyDir) && hit.live === fingerprint(liveDir) ? hit : null;
}

export function rememberKept(brainHome, copyDir, liveDir, proof) {
  try {
    const cache = readProofCache(brainHome);
    cache.entries[copyDir] = { rule: PROOF_RULE, copy: fingerprint(copyDir), live: fingerprint(liveDir), reason: proof.reason,
      unique: (proof.unique || []).slice(0, 10), at: new Date().toISOString() };
    const file = path.join(brainHome, PROOF_CACHE);
    fs.writeFileSync(`${file}.tmp-${process.pid}`, JSON.stringify(cache));
    fs.renameSync(`${file}.tmp-${process.pid}`, file);
  } catch { /* uncached: the next sweep proves it again, which is only slower */ }
}

/** The honest remedy for a kept copy: what it holds, and the explicit archive command that releases it (#335). */
export const keptCopyFix = (copyDir, hit) => `npx ruvnet-brain --clean --archive — ${copyDir} is kept because it holds ${
  (hit.unique || []).some((u) => /private/i.test(u.why || '')) ? 'private ' : ''}data the live brain lacks (${
  (hit.unique || []).slice(0, 3).map((u) => u.file).join(', ') || hit.reason}); that copies only those files into kb.archive/ and releases the copy (or restore them into the live brain yourself)`;

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Every `<archiveDir>/<stamp>/<label>` tree `--clean --archive` wrote: real directories only, links never entered. */
export function archiveRoots(archiveDir) {
  const real = (p) => { const st = lstat(p); return Boolean(st && st.isDirectory() && !st.isSymbolicLink()); };
  if (!real(archiveDir)) return [];
  return names(archiveDir).map((s) => path.join(archiveDir, s)).filter(real)
    .flatMap((stampDir) => names(stampDir).map((n) => path.join(stampDir, n)).filter(real));
}

/**
 * #335 `--clean --archive` (explicit, never automatic): COPY exactly the files a KEPT proof named unique into
 * `<stampDir>/<label>/<same relative path>`, verify each byte-for-byte, and write `<stampDir>/<label>.json`.
 * Moves and deletes nothing: the caller re-proves the copy against this archive before releasing it. A link,
 * an unsafe ancestor, a non-regular file, too little free space or any copy error archives nothing usable.
 */
export function archiveUniqueFiles({ copyDir, unique, stampDir, label, now = Date.now() }) {
  if (!Array.isArray(unique) || !unique.length) return { ok: false, reason: 'no file is named unique; the copy is kept for another reason' };
  const root = path.join(stampDir, label);
  if (lstat(root)) return { ok: false, reason: `${root} already exists` };
  let need = 0;
  for (const { file, why } of unique) {
    const st = lstat(path.join(copyDir, file));
    if (/link|ancestor/i.test(String(why)) || !st || !st.isFile() || st.isSymbolicLink()) return { ok: false, reason: `${file} is not a regular file that can be archived (${why})` };
    need += st.size;
  }
  try {
    fs.mkdirSync(stampDir, { recursive: true });
    const free = typeof fs.statfsSync === 'function' ? fs.statfsSync(stampDir) : null;
    if (free && Number(free.bavail) * Number(free.bsize) < need + 64 * 1024 * 1024) {
      return { ok: false, reason: `not enough free space to archive ${need} bytes` };
    }
    const files = [];
    for (const { file } of unique) {
      const src = path.join(copyDir, file); const dst = path.join(root, file);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      const sha256 = sha256File(src);
      if (sha256File(dst) !== sha256) throw new Error(`archived bytes of ${file} differ from the source`);
      files.push({ file, bytes: fs.lstatSync(dst).size, sha256 });
    }
    fs.writeFileSync(path.join(stampDir, `${label}.json`), `${JSON.stringify({ schemaVersion: 1, kind: 'ruvnet-brain-kb-archive',
      source: copyDir, archivedAt: new Date(now).toISOString(), files }, null, 2)}\n`);
    return { ok: true, root, files, bytes: need };
  } catch (error) { return { ok: false, reason: `archive failed: ${error.message}` }; }
}
