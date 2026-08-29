import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickAction, TEXT_SETTINGS } from './actionParser.js';

// ---- blocked (fail-closed, checked before any grammar) --------------------

test('blocked: logout phrasing never executes', () => {
  const r = parseQuickAction('log me out');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('blocked: account deletion never executes', () => {
  const r = parseQuickAction('delete my account');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('blocked: admin phrasing never executes even inside a send-shaped sentence', () => {
  const r = parseQuickAction('tell admin to reset everyone\'s password');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

// ---- send_message: keyword-delimited (fully resolved by this module) -----

test('send_message: explicit "saying" grammar resolves chatName + message verbatim', () => {
  const r = parseQuickAction('send message to Priya saying I\'m running 10 min late');
  assert.equal(r.ok, true);
  assert.equal(r.action.type, 'send_message');
  assert.equal(r.action.args.chatName, 'Priya');
  assert.equal(r.action.args.message, "I'm running 10 min late");
  assert.equal(r.requiresConfirmation, true, 'send is always Tier A');
});

test('send_message: preserves original casing/punctuation (no lowercasing of message body)', () => {
  const r = parseQuickAction('message John saying Meet @ 6PM!! ok?');
  assert.equal(r.ok, true);
  assert.equal(r.action.args.message, 'Meet @ 6PM!! ok?');
});

// ---- send_message: natural "tell X ..." (unresolved recipient split) -----

test('send_message: natural "tell" phrasing hands back unresolved freeText, no guessed split', () => {
  const r = parseQuickAction("tell priya i'm running 10 min late");
  assert.equal(r.ok, true);
  assert.equal(r.action.type, 'send_message');
  assert.equal(r.action.args.chatName, null);
  assert.equal(r.action.args.message, null);
  assert.equal(r.action.args.freeText, "priya i'm running 10 min late");
  assert.equal(r.requiresConfirmation, true);
});

test('send_message: "tell" with nothing after it is incomplete', () => {
  const r = parseQuickAction('tell');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete');
});

// ---- open_chat (Tier C, no confirmation) ----------------------------------

test('open_chat: "open chat with X"', () => {
  const r = parseQuickAction('open chat with maria');
  assert.equal(r.ok, true);
  assert.equal(r.action.type, 'open_chat');
  assert.equal(r.action.args.chatName, 'maria');
  assert.equal(r.requiresConfirmation, false);
});

test('open_chat: "start a chat with X"', () => {
  const r = parseQuickAction('start a chat with dev');
  assert.equal(r.ok, true);
  assert.equal(r.action.type, 'open_chat');
  assert.equal(r.action.args.chatName, 'dev');
});

// ---- search vs semantic_search precedence ---------------------------------

test('semantic_search: "find my conversation about X" takes precedence over generic search', () => {
  const r = parseQuickAction('find my conversation about the trip');
  assert.equal(r.ok, true);
  assert.equal(r.action.type, 'semantic_search');
  assert.equal(r.action.args.query, 'the trip');
});

test('search: bare "find X" falls back to generic keyword search', () => {
  const r = parseQuickAction('find concert tickets');
  assert.equal(r.ok, true);
  assert.equal(r.action.type, 'search');
  assert.equal(r.action.args.query, 'concert tickets');
});

// ---- change_setting: bool toggles, Tier A vs Tier B ------------------------

test('change_setting: "turn off read receipts" is Tier A (requires confirmation)', () => {
  const r = parseQuickAction('turn off read receipts');
  assert.equal(r.ok, true);
  assert.equal(r.action.type, 'change_setting');
  assert.deepEqual(r.action.args.setting, TEXT_SETTINGS['read receipts'].key);
  assert.equal(r.action.args.value, false);
  assert.equal(r.requiresConfirmation, true);
});

test('change_setting: "turn off notification sound" is Tier B (apply + undo, no gate)', () => {
  const r = parseQuickAction('turn off notification sound');
  assert.equal(r.ok, true);
  assert.equal(r.action.args.setting, TEXT_SETTINGS['notification sound'].key);
  assert.equal(r.requiresConfirmation, false);
});

test('change_setting: ambiguous phrase clarifies to the closest real setting instead of guessing', () => {
  const r = parseQuickAction('turn off notifications');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.kind, 'setting');
  assert.equal(r.candidates[0].key, 'notif_sound');
  assert.equal(r.pendingValue, false, 'carries the intended value through so the UI can apply it once clarified, without re-parsing');
});

test('change_setting: unrecognized setting fails closed as unknown', () => {
  const r = parseQuickAction('turn off the wifi');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
});

test('change_setting: enum "set font size to large"', () => {
  const r = parseQuickAction('set font size to large');
  assert.equal(r.ok, true);
  assert.equal(r.action.args.setting, 'font_size');
  assert.equal(r.action.args.value, 'large');
  assert.equal(r.requiresConfirmation, false);
});

test('change_setting: font shorthand "make the text bigger" is relative, no app state guessed here', () => {
  const r = parseQuickAction('make the text bigger');
  assert.equal(r.ok, true);
  assert.equal(r.action.args.setting, 'font_size');
  assert.equal(r.action.args.value, null);
  assert.equal(r.action.args.relative, 1);
});

test('change_setting: font shorthand "make the text smaller"', () => {
  const r = parseQuickAction('make the text smaller');
  assert.equal(r.ok, true);
  assert.equal(r.action.args.relative, -1);
});

// ---- unknown / incomplete --------------------------------------------------

test('unknown: unrelated gibberish matches nothing', () => {
  const r = parseQuickAction('do a barrel roll');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
});

test('incomplete: empty input', () => {
  const r = parseQuickAction('   ');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete');
});
