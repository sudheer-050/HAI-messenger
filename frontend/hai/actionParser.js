/**
 * Quick Actions (HAI) deterministic text-command parser.
 *
 * Consumes a typed instruction string and returns a structured result. No
 * DOM, no network, no AI/LLM, no semantic guessing, no contact-list access —
 * this file only knows fixed grammar and the approved v1 settings list.
 * Recipient resolution (matching free text against the user's real contacts)
 * happens one layer up, in index.html, which is the only place that actually
 * holds that data. That keeps this module trivially unit-testable and keeps
 * a hard boundary between "what did the user type" and "what does that
 * resolve to in this account's data" (see MYAG-183 / MYAG-180).
 *
 * Grammar is deliberately different from frontend/voice/commandParser.js:
 * voice transcripts are terse ("send message to mom saying ...") because
 * dictation is slow and error-prone; typed Quick Actions grammar accepts
 * fuller natural phrasing ("tell mom I'm running late"). BLOCKED_PATTERNS is
 * imported from commandRegistry.js so both surfaces can never disagree on
 * what's forbidden — but the settings allowlist is intentionally separate
 * (TEXT_SETTINGS below): Quick Actions v1 ships a narrower, explicitly
 * reviewed slice of 5 settings, not voice's broader (and not-yet-wired) list.
 *
 * Result shape:
 *   success: { ok: true, action: HaiAction, requiresConfirmation: boolean }
 *   failure: { ok: false, reason: 'unknown'|'incomplete'|'blocked'|'ambiguous', detail, ...extra }
 *
 * A failure result carries no action for a caller to act on — treat it as
 * "do nothing" (blocked/unknown/incomplete) or "ask the user" (ambiguous).
 */

import { BLOCKED_PATTERNS } from '../voice/commandRegistry.js';

// The approved Quick Actions v1 settings slice (Stage-1 UX spec, MYAG-181,
// "Flow C"). Deliberately excludes anything account/security-sensitive.
// tier 'A' = visible to another person / hard to undo -> explicit confirm.
// tier 'B' = local + one-tap reversible -> apply immediately, offer Undo.
export const TEXT_SETTINGS = Object.freeze({
  'read receipts': Object.freeze({
    key: 'read_receipts', kind: 'bool', label: 'Read Receipts', tier: 'A',
    consequence: "Others won't see when you've read their messages.",
  }),
  'last seen': Object.freeze({
    key: 'last_seen', kind: 'bool', label: 'Last Seen', tier: 'A',
    consequence: "Others won't see when you were last online.",
  }),
  'notification sound': Object.freeze({
    key: 'notif_sound', kind: 'bool', label: 'Notification Sound', tier: 'B',
  }),
  'enter is send': Object.freeze({
    key: 'enter_is_send', kind: 'bool', label: 'Enter Is Send', tier: 'B',
  }),
  'font size': Object.freeze({
    key: 'font_size', kind: 'enum', label: 'Font Size', tier: 'B',
    values: Object.freeze(['small', 'medium', 'large']),
  }),
});

// Phrases that are real app concepts but don't map to exactly one setting —
// clarify against the closest real setting instead of guessing (UX spec §2C).
const TEXT_SETTINGS_CLARIFY = Object.freeze({
  notifications: 'notification sound',
  notification: 'notification sound',
  'text size': 'font size',
  'font': 'font size',
});

const OPEN_TRIGGERS = [
  /^open(?:\s+chat)?(?:\s+with)?\s+(.+)$/i,
  /^start(?:\s+a)?(?:\s+new)?\s+chat\s+with\s+(.+)$/i,
  /^go\s+to\s+(.+)$/i,
  /^show\s+me\s+(.+)$/i,
  /^switch\s+to\s+(.+)$/i,
];

// Checked BEFORE the generic search triggers below so "find messages/my
// conversation about X" doesn't fall through to a plain keyword search.
const SEMANTIC_SEARCH_TRIGGERS = [
  /^find\s+(?:my\s+)?(?:conversation|conversations|messages)(?:\s+about)?\s+(.+)$/i,
  /^what\s+did\s+.+?\s+(?:talk|say|discuss)\s+about\s+(.+)$/i,
];

const SEARCH_TRIGGERS = [
  /^search(?:\s+for)?\s+(.+)$/i,
  /^look\s+for\s+(.+)$/i,
  /^find\s+(.+)$/i,
];

// Keyword-delimited send — unambiguous, resolves chatName + message in one
// shot (no app-side name/message split needed).
const SEND_EXPLICIT_TRIGGERS = [
  /^send(?:\s+(?:a\s+)?message)?(?:\s+to)?\s+(.+?)\s+saying\s+(.+)$/is,
  /^(?:message|text)\s+(.+?)\s+saying\s+(.+)$/is,
];

// Bare trigger word with nothing after it — fails closed as incomplete
// rather than falling through to "unknown" (there's no useful clarification
// to offer besides "say more").
const SEND_BARE_TRIGGER = /^(?:tell|message|text)$/i;

// Natural "tell X ..." phrasing has no keyword separating recipient from
// message text ("tell priya i'm running late") — this module can't split
// that without the real contact list, so it hands the whole free-text blob
// up unresolved (see `freeText` on the returned action) for index.html to
// split against real contacts.
const SEND_TELL_TRIGGERS = [
  /^tell\s+(.+)$/is,
  /^message\s+(.+)$/is,
  /^text\s+(.+)$/is,
];

const SETTING_ON_OFF = /^turn\s+(on|off)\s+(.+)$/i;
const SETTING_SET = /^set\s+(.+?)\s+to\s+(.+)$/i;
const FONT_SHORTHAND = /^make\s+(?:the\s+)?text\s+(bigger|larger|smaller)$/i;

function normalizeForMatch(input) {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

function ok(action, requiresConfirmation) {
  return Object.freeze({ ok: true, action: Object.freeze(action), requiresConfirmation });
}

function fail(reason, detail, extra) {
  return Object.freeze({ ok: false, reason, detail, ...(extra || {}) });
}

function resolveSettingToggle(rawPhrase, boolValue) {
  const phrase = rawPhrase.trim().toLowerCase();
  const clarifyTo = TEXT_SETTINGS_CLARIFY[phrase];
  if (clarifyTo) {
    return fail('ambiguous', `"${rawPhrase}" isn't a single setting`, {
      kind: 'setting',
      candidates: [TEXT_SETTINGS[clarifyTo]],
      pendingValue: boolValue,
    });
  }
  const setting = TEXT_SETTINGS[phrase];
  if (!setting || setting.kind !== 'bool') {
    return fail('unknown', `"${rawPhrase}" is not a recognized Quick Actions setting`);
  }
  return ok(
    { type: 'change_setting', args: { setting: setting.key, value: boolValue, label: setting.label, tier: setting.tier, consequence: setting.consequence || null } },
    setting.tier === 'A'
  );
}

function resolveSettingSet(rawPhrase, rawValue) {
  const phrase = rawPhrase.trim().toLowerCase();
  const value = rawValue.trim().toLowerCase();
  // Unlike the "turn on/off" grammar, "set X to Y" already supplies a concrete
  // value, so a clarify-mapped phrase (e.g. "notifications") can resolve straight
  // to its canonical setting without a clarification round-trip — there's nothing
  // left to disambiguate once the value is known.
  const clarifyTo = TEXT_SETTINGS_CLARIFY[phrase];
  const setting = TEXT_SETTINGS[clarifyTo || phrase];
  if (!setting) return fail('unknown', `"${rawPhrase}" is not a recognized Quick Actions setting`);

  if (setting.kind === 'enum') {
    if (!setting.values.includes(value)) {
      return fail('unknown', `"${rawValue}" is not a valid value for ${setting.label}`);
    }
    return ok(
      { type: 'change_setting', args: { setting: setting.key, value, label: setting.label, tier: setting.tier, consequence: setting.consequence || null } },
      setting.tier === 'A'
    );
  }

  const boolValue = ['on', 'true', 'enabled', 'enable'].includes(value)
    ? true
    : ['off', 'false', 'disabled', 'disable'].includes(value)
    ? false
    : null;
  if (boolValue === null) return fail('unknown', `"${rawValue}" is not a valid value for ${setting.label}`);
  return ok(
    { type: 'change_setting', args: { setting: setting.key, value: boolValue, label: setting.label, tier: setting.tier, consequence: setting.consequence || null } },
    setting.tier === 'A'
  );
}

function resolveFontShorthand(direction) {
  const setting = TEXT_SETTINGS['font size'];
  // No app state here (see module doc) — index.html resolves `relative` against
  // the user's actual current font size before showing/applying anything.
  return ok(
    { type: 'change_setting', args: { setting: setting.key, value: null, relative: direction === 'smaller' ? -1 : 1, label: setting.label, tier: setting.tier, consequence: null } },
    false
  );
}

/**
 * @param {string} rawText raw typed instruction from the Quick Actions input
 * @returns {{ok: true, action: object, requiresConfirmation: boolean} | {ok: false, reason: string, detail: string}}
 */
export function parseQuickAction(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return fail('incomplete', 'empty input');

  const norm = normalizeForMatch(text);
  if (BLOCKED_PATTERNS.some((rx) => rx.test(norm))) {
    return fail('blocked', 'this instruction matches a blocked action and can never run from Quick Actions');
  }

  for (const rx of SEMANTIC_SEARCH_TRIGGERS) {
    const m = text.match(rx);
    if (m) {
      const query = m[m.length - 1].trim();
      if (!query) return fail('incomplete', 'semantic_search requires a topic');
      return ok({ type: 'semantic_search', args: { query } }, false);
    }
  }

  for (const rx of SEND_EXPLICIT_TRIGGERS) {
    const m2 = text.match(rx);
    if (m2) {
      const chatName = m2[1].trim();
      const message = m2[2].trim();
      if (!chatName) return fail('incomplete', 'send_message requires a recipient');
      if (!message) return fail('incomplete', 'send_message requires message text');
      return ok({ type: 'send_message', args: { chatName, message, freeText: null } }, true);
    }
  }

  if (SEND_BARE_TRIGGER.test(text)) {
    return fail('incomplete', 'send_message requires a recipient and a message');
  }

  let m;
  for (const rx of SEND_TELL_TRIGGERS) {
    m = text.match(rx);
    if (m) {
      const freeText = m[1].trim();
      if (!freeText) return fail('incomplete', 'send_message requires a recipient and a message');
      return ok({ type: 'send_message', args: { chatName: null, message: null, freeText } }, true);
    }
  }

  m = text.match(SETTING_ON_OFF);
  if (m) return resolveSettingToggle(m[2], m[1].toLowerCase() === 'on');

  m = text.match(SETTING_SET);
  if (m) return resolveSettingSet(m[1], m[2]);

  m = text.match(FONT_SHORTHAND);
  if (m) return resolveFontShorthand(m[1].toLowerCase());

  for (const rx of OPEN_TRIGGERS) {
    m = text.match(rx);
    if (m) {
      const chatName = m[1].trim();
      if (!chatName) return fail('incomplete', 'open_chat requires a chat name');
      return ok({ type: 'open_chat', args: { chatName } }, false);
    }
  }

  for (const rx of SEARCH_TRIGGERS) {
    m = text.match(rx);
    if (m) {
      const query = m[1].trim();
      if (!query) return fail('incomplete', 'search requires a query');
      return ok({ type: 'search', args: { query } }, false);
    }
  }

  return fail('unknown', 'no known Quick Actions command matched this instruction');
}
