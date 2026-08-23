/**
 * Deterministic voice-command registry.
 *
 * Pure data: command IDs, trigger-phrase synonyms, argument grammar, and the
 * settings allow/block lists. No parsing logic, no DOM, no network, no AI.
 * Adding a synonym or a new allowed setting only requires editing the arrays
 * below — commandParser.js never needs to change for that.
 */

// argMode determines how commandParser.js extracts arguments from the text
// that follows a matched trigger phrase:
//   'none'    - no argument allowed (e.g. "close chat")
//   'trailing'- the entire remainder is a single free-text argument
//   'send'    - "[to <chat>] saying <message>"
//   'forward' - "to <chat>"
//   'setting' - "<setting name> to <value>"
export const COMMANDS = Object.freeze([
  Object.freeze({
    id: 'open_chat',
    synonyms: Object.freeze(['open chat', 'open', 'go to', 'show me']),
    argMode: 'trailing',
    argName: 'chatName',
  }),
  Object.freeze({
    id: 'close_chat',
    synonyms: Object.freeze([
      'close chat',
      'close the chat',
      'close current chat',
      'exit chat',
    ]),
    argMode: 'none',
  }),
  Object.freeze({
    id: 'send_message',
    synonyms: Object.freeze(['send message', 'dictate message', 'send']),
    argMode: 'send',
  }),
  Object.freeze({
    id: 'change_setting',
    synonyms: Object.freeze(['change setting', 'change', 'set']),
    argMode: 'setting',
  }),
  Object.freeze({
    id: 'forward_message',
    synonyms: Object.freeze([
      'forward selected message',
      'forward message',
      'forward this',
      'forward',
    ]),
    argMode: 'forward',
  }),
  Object.freeze({
    id: 'search',
    synonyms: Object.freeze(['search for', 'search', 'look for', 'find']),
    argMode: 'trailing',
    argName: 'query',
  }),
]);

// Setting name -> canonical key. Only settings listed here can ever be
// changed by voice. Anything not present here and not in SETTING_BLOCKLIST
// is simply "unknown" (fails closed, does nothing).
export const SETTINGS_ALLOWLIST = Object.freeze({
  theme: 'theme',
  'dark mode': 'theme',
  'color theme': 'theme',
  'font size': 'fontSize',
  'text size': 'fontSize',
  wallpaper: 'wallpaper',
  'chat wallpaper': 'wallpaper',
  'chat background': 'wallpaper',
  language: 'language',
  'notification sound': 'notificationSound',
  notifications: 'notifications',
  'read receipts': 'readReceipts',
});

// Phrases that must always fail closed with reason 'blocked', regardless of
// which command grammar they otherwise resemble. Matched anywhere in the
// normalized transcript so a rephrasing can't route around it.
export const BLOCKED_PATTERNS = Object.freeze([
  /\blog\s*in\b/,
  /\blog\s*(?:me\s+|myself\s+|us\s+)?out\b/,
  /\bsign\s*in\b/,
  /\bsign\s*(?:me\s+|myself\s+|us\s+)?out\b/,
  /\bpassword\b/,
  /\bdelete\s+(my\s+)?account\b/,
  /\bdeactivate\s+(my\s+)?account\b/,
  /\b(chat\s+)?pin\b/,
  /\block\b/,
  /\bunlock\b/,
  /\bclear\s+(chat\s+)?history\b/,
  /\bdelete\s+history\b/,
  /\bwipe\b/,
  /\badmin\b/,
  /\bdestroy\b/,
]);
