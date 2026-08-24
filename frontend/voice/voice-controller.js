import { STTAdapter } from './stt-adapter.js';
import { parseVoiceCommand } from './commandParser.js';

const RISKY = new Set(['send_message', 'forward_message', 'change_setting']);

export function resolveContact(name, contacts) {
  const wanted = String(name || '').trim().toLowerCase();
  const matches = (contacts || []).filter(c => [c.username, c.label].some(v => String(v || '').trim().toLowerCase() === wanted));
  return matches.length === 1 ? { ok: true, contact: matches[0] } : { ok: false, reason: matches.length ? 'ambiguous' : 'not_found', matches };
}

export function createVoiceController({ bridge, elements, Adapter = STTAdapter, timeoutMs = 15000 }) {
  let adapter, timer, pending;
  let state = 'idle';
  const setState = (next, text = '') => {
    state = next;
    elements.panel.hidden = next === 'idle';
    elements.panel.dataset.state = next;
    elements.status.textContent = text;
    elements.mic.setAttribute('aria-pressed', String(next === 'listening'));
    elements.mic.setAttribute('aria-label', next === 'listening' ? 'Stop voice control' : 'Start voice control');
  };
  const release = () => { clearTimeout(timer); timer = null; adapter?.stop(); };
  const cancel = () => { pending = null; elements.confirm.hidden = true; release(); setState('idle'); };
  const fail = message => { cancel(); setState('error', message); };
  const contact = name => {
    const result = resolveContact(name, bridge.getContacts());
    if (!result.ok) fail(result.reason === 'ambiguous' ? `More than one contact matches “${name}”. Choose one manually.` : `No exact contact matches “${name}”. Choose one manually.`);
    return result.ok ? result.contact.username : null;
  };
  const prepare = parsed => {
    const args = { ...parsed.args };
    if (args.chatName && !(args.username = contact(args.chatName))) return null;
    if (parsed.command === 'send_message' && !args.username && !bridge.getActiveChat()) {
      fail('Open a chat manually before sending without a named contact.'); return null;
    }
    if (parsed.command === 'forward_message') {
      const target = bridge.getForwardTarget?.();
      if (!target?.messageId) {
        fail('Select a message using its message menu before forwarding.'); return null;
      }
      args.messageId = target.messageId;
    }
    return { command: parsed.command, args };
  };
  const execute = ({ command, args }) => {
    if (command === 'open_chat') bridge.openChat(args.username);
    else if (command === 'close_chat') bridge.closeChat();
    else if (command === 'search') bridge.search(args.query);
    else if (command === 'send_message') bridge.send(args.username, args.message);
    else if (command === 'forward_message') bridge.forward(args.username, args.messageId);
    else if (command === 'change_setting') bridge.changeSetting(args.setting, args.value);
    setState('idle');
  };
  const onTranscript = event => {
    release();
    const parsed = parseVoiceCommand(event.detail?.text || '');
    if (!parsed.ok) return fail(parsed.reason === 'blocked' ? 'That action is blocked for voice control.' : `Command not run (${parsed.reason}). Use the screen controls or try again.`);
    const action = prepare(parsed);
    if (!action) return;
    if (!RISKY.has(action.command)) return execute(action);
    pending = action;
    elements.summary.textContent = bridge.describe(action);
    elements.confirm.hidden = false;
    setState('confirming', 'Tap Confirm to continue.');
  };
  const start = async () => {
    if (state === 'listening' || state === 'downloading') return cancel();
    pending = null; elements.confirm.hidden = true;
    try {
      adapter ||= new Adapter();
      if (!adapter.ready) {
        setState('downloading', 'Preparing private on-device speech recognition…');
        await adapter.init(p => setState('downloading', p.phase === 'download' ? `Downloading voice model… ${Math.round(p.ratio * 100)}%` : 'Preparing voice model…'));
      }
      adapter.addEventListener('transcript', onTranscript, { once: true });
      adapter.addEventListener('error', e => fail(e.detail?.message || 'Voice recognition failed.'), { once: true });
      await adapter.start();
      if (!adapter.listening) return;
      setState('listening', 'Listening on this device… tap the mic to stop.');
      timer = setTimeout(() => fail('Listening timed out. Tap the mic to try again.'), timeoutMs);
    } catch (error) { fail(error.message || 'Voice recognition failed.'); }
  };
  elements.mic.addEventListener('click', start);
  elements.cancel.addEventListener('click', cancel);
  elements.dismiss.addEventListener('click', cancel);
  elements.approve.addEventListener('click', () => { const action = pending; pending = null; elements.confirm.hidden = true; if (action) execute(action); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('pagehide', cancel);
  window.addEventListener('popstate', cancel);
  return { start, cancel, get state() { return state; } };
}

if (typeof window !== 'undefined' && window.haiVoiceBridge) createVoiceController({ bridge: window.haiVoiceBridge, elements: {
  panel: document.getElementById('voiceControlPanel'), mic: document.getElementById('voiceCommandButton'),
  status: document.getElementById('voiceCommandStatus'), confirm: document.getElementById('voiceCommandConfirm'),
  summary: document.getElementById('voiceCommandSummary'), approve: document.getElementById('voiceCommandConfirmButton'),
  dismiss: document.getElementById('voiceCommandDismissButton'), cancel: document.getElementById('voiceCommandCancelButton'),
}});
