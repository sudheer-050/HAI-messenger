/**
 * Deterministic voice-command parser.
 *
 * Consumes a transcript string and returns a structured result. No DOM, no
 * network, no AI/LLM/intent model, no semantic guessing. All command shapes,
 * synonyms, and the settings allow/block lists live in commandRegistry.js —
 * this file only implements the fixed grammar around that data.
 *
 * Result shape:
 *   success: { ok: true, command: <id>, args: { ... } }
 *   failure: { ok: false, reason: 'unknown'|'ambiguous'|'incomplete'|'malformed'|'blocked', detail }
 *
 * Any input that isn't an unambiguous, complete, allowed match fails closed
 * (ok: false) and produces no args for a caller to act on.
 */

import { COMMANDS, SETTINGS_ALLOWLIST, BLOCKED_PATTERNS } from './commandRegistry.js';

function validateRegistry(commands) {
  const owner = new Map();
  for (const command of commands) {
    for (const phrase of command.synonyms) {
      const key = phrase.toLowerCase().trim();
      const existing = owner.get(key);
      if (existing && existing !== command.id) {
        throw new Error(
          `commandRegistry: synonym "${phrase}" is claimed by both "${existing}" and "${command.id}"`
        );
      }
      owner.set(key, command.id);
    }
  }
}

validateRegistry(COMMANDS);

function normalize(input) {
  if (typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ok(command, args) {
  return Object.freeze({ ok: true, command, args: Object.freeze({ ...args }) });
}

function fail(reason, detail) {
  return Object.freeze({ ok: false, reason, detail });
}

// Finds the longest trigger phrase (across all commands) that the normalized
// transcript begins with. Ties between different commands are ambiguous.
function matchTrigger(normalized) {
  let best = null;
  let bestLen = -1;
  let ambiguous = false;

  for (const command of COMMANDS) {
    for (const phrase of command.synonyms) {
      let remainder = null;
      if (normalized === phrase) {
        remainder = '';
      } else if (normalized.startsWith(`${phrase} `)) {
        remainder = normalized.slice(phrase.length + 1).trim();
      } else {
        continue;
      }

      if (phrase.length > bestLen) {
        bestLen = phrase.length;
        best = { command, remainder };
        ambiguous = false;
      } else if (phrase.length === bestLen && best && best.command.id !== command.id) {
        ambiguous = true;
      }
    }
  }

  if (!best) return { status: 'unknown' };
  if (ambiguous) return { status: 'ambiguous' };
  return { status: 'matched', command: best.command, remainder: best.remainder };
}

function parseSend(remainder) {
  if (!remainder) return fail('incomplete', 'send_message requires "[to <chat>] saying <message>"');
  const m = remainder.match(/^(?:to\s+(.+?)\s+)?saying\s+(.+)$/s);
  if (!m) return fail('malformed', 'send_message requires the keyword "saying" before the message');
  const chatName = m[1] ? m[1].trim() : null;
  const message = m[2].trim();
  if (chatName !== null && !chatName) {
    return fail('incomplete', 'send_message target chat name is empty');
  }
  if (!message) return fail('incomplete', 'send_message requires message text');
  return ok('send_message', { chatName, message });
}

function parseForward(remainder) {
  if (!remainder) return fail('incomplete', 'forward_message requires "to <chat name>"');
  const m = remainder.match(/^to\s+(.+)$/s);
  if (!m) return fail('malformed', 'forward_message requires the keyword "to" before the chat name');
  const chatName = m[1].trim();
  if (!chatName) return fail('incomplete', 'forward_message target chat name is empty');
  return ok('forward_message', { chatName });
}

function parseSetting(remainder) {
  if (!remainder) return fail('incomplete', 'change_setting requires "<setting> to <value>"');
  const m = remainder.match(/^(.+?)\s+to\s+(.+)$/s);
  if (!m) return fail('malformed', 'change_setting requires the keyword "to" between setting and value');
  const rawSetting = m[1].trim();
  const value = m[2].trim();
  if (!value) return fail('incomplete', 'change_setting requires a value');

  if (BLOCKED_PATTERNS.some((rx) => rx.test(rawSetting))) {
    return fail('blocked', `setting "${rawSetting}" is not permitted by voice`);
  }

  const settingKey = SETTINGS_ALLOWLIST[rawSetting];
  if (!settingKey) return fail('unknown', `setting "${rawSetting}" is not recognized`);

  return ok('change_setting', { setting: settingKey, value });
}

function dispatch(command, remainder) {
  switch (command.argMode) {
    case 'none':
      if (remainder) return fail('malformed', `${command.id} does not accept arguments`);
      return ok(command.id, {});
    case 'trailing':
      if (!remainder) return fail('incomplete', `${command.id} requires ${command.argName}`);
      return ok(command.id, { [command.argName]: remainder });
    case 'send':
      return parseSend(remainder);
    case 'forward':
      return parseForward(remainder);
    case 'setting':
      return parseSetting(remainder);
    default:
      return fail('malformed', `unrecognized argMode for ${command.id}`);
  }
}

/**
 * @param {string} transcript raw transcript text from local STT
 * @returns {{ok: true, command: string, args: object} | {ok: false, reason: string, detail: string}}
 */
export function parseVoiceCommand(transcript) {
  const normalized = normalize(transcript);
  if (!normalized) return fail('incomplete', 'empty transcript');

  if (BLOCKED_PATTERNS.some((rx) => rx.test(normalized))) {
    return fail('blocked', 'transcript matches a blocked action');
  }

  const match = matchTrigger(normalized);
  if (match.status === 'unknown') return fail('unknown', 'no known command matched');
  if (match.status === 'ambiguous') return fail('ambiguous', 'multiple commands match this phrasing');

  return dispatch(match.command, match.remainder);
}

export { validateRegistry, normalize as __normalizeForTests };
