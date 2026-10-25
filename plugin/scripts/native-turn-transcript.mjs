/** Bounded, mechanical Codex JSONL normalization. No model inference or user-text persistence. */
const LIMIT = 2 * 1024 * 1024;
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => ['text', 'Text', 'input_text', 'output_text'].includes(part?.type)).map(part => part.text || '').join('\n') : '';
const message = (role, content) => ({ message: { role, content } });
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

/** Keep call IDs intact; torn/unknown records cannot manufacture successful tool evidence. */
export function nativeTurnLines(lines, host) {
  if (host !== 'codex') return lines;
  const records = []; let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(String(lines[i]));
    if (bytes > LIMIT) break;
    const record = parse(lines[i]); if (record) records.push(record);
  }
  records.reverse();
  const out = []; const sessions = new Map(); const calls = new Map();
  // Codex writes the same answer up to three times (response_item, item_completed AgentMessage,
  // task_complete.last_agent_message); any one of them may be the only copy that survived.
  let said = new Set();
  const say = (role, value) => {
    if (role === 'user') said = new Set();
    else if (said.has(value.trim())) return;
    else said.add(value.trim());
    out.push(message(role, value));
  };
  for (const record of records) {
    const p = record.payload;
    if (record.type === 'event_msg' && p?.type === 'user_message') {
      say('user', p.message || ''); continue;
    }
    if (record.type === 'event_msg' && p?.type === 'agent_message' && typeof p.message === 'string') {
      say('assistant', p.message); continue;
    }
    // Native turn end (rollout and `codex exec`): the closing answer, recorded once per turn.
    if (record.type === 'event_msg' && p?.type === 'task_complete' && typeof p.last_agent_message === 'string') {
      say('assistant', p.last_agent_message); continue;
    }
    if (record.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'AgentMessage') {
      say('assistant', text(p.item.content)); continue;
    }
    if (record.type !== 'response_item' || !p) continue;
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      say(p.role, text(p.content)); continue;
    }
    if (['function_call', 'custom_tool_call'].includes(p.type) && typeof p.call_id === 'string') {
      const args = typeof p.arguments === 'string' ? parse(p.arguments) : p.arguments;
      let name = String(p.name || '').split('.').at(-1); let input = args || {};
      if (name === 'exec_command' && typeof args?.cmd === 'string') { name = 'Bash'; input = { command: args.cmd }; }
      if (name === 'apply_patch') input = { input: p.input || '' };
      if (name === 'write_stdin' && sessions.has(args?.session_id)) {
        name = 'Bash'; input = { command: sessions.get(args.session_id) };
      }
      calls.set(p.call_id, { name, input });
      out.push(message('assistant', [{ type: 'tool_use', id: p.call_id, name, input }]));
    } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && typeof p.call_id === 'string') {
      const result = typeof p.output === 'string' ? parse(p.output) : p.output;
      const call = calls.get(p.call_id);
      if (Number.isSafeInteger(result?.session_id) && call?.name === 'Bash') sessions.set(result.session_id, call.input.command);
      // Native structured exit fields are retained; opaque text is never guessed to be a pass.
      out.push(message('user', [{ ...(result && typeof result === 'object' ? result : {}),
        type: 'tool_result', tool_use_id: p.call_id, content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '') }]));
    }
  }
  return out.map(record => JSON.stringify(record));
}
