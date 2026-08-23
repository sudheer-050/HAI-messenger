import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVoiceCommand, validateRegistry } from './commandParser.js';
import { COMMANDS } from './commandRegistry.js';

// ---- canonical phrases -----------------------------------------------

test('open_chat: canonical phrase', () => {
  const r = parseVoiceCommand('open chat mom');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'open_chat');
  assert.equal(r.args.chatName, 'mom');
});

test('close_chat: canonical phrase, no args', () => {
  const r = parseVoiceCommand('close chat');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'close_chat');
  assert.deepEqual(r.args, {});
});

test('send_message: canonical phrase with target chat', () => {
  const r = parseVoiceCommand('send message to mom saying I am on my way');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'send_message');
  assert.equal(r.args.chatName, 'mom');
  assert.equal(r.args.message, 'i am on my way');
});

test('send_message: canonical phrase without target chat sends to current chat', () => {
  const r = parseVoiceCommand('send message saying be there in five minutes');
  assert.equal(r.ok, true);
  assert.equal(r.args.chatName, null);
  assert.equal(r.args.message, 'be there in five minutes');
});

test('change_setting: canonical phrase', () => {
  const r = parseVoiceCommand('change setting theme to dark');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'change_setting');
  assert.deepEqual(r.args, { setting: 'theme', value: 'dark' });
});

test('forward_message: canonical phrase', () => {
  const r = parseVoiceCommand('forward selected message to john');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'forward_message');
  assert.equal(r.args.chatName, 'john');
});

test('search: canonical phrase', () => {
  const r = parseVoiceCommand('search for concert tickets');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'search');
  assert.equal(r.args.query, 'concert tickets');
});

// ---- synonyms -----------------------------------------------------------

test('open_chat: synonym "go to"', () => {
  const r = parseVoiceCommand('go to the family group');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'open_chat');
  assert.equal(r.args.chatName, 'the family group');
});

test('open_chat: synonym "show me"', () => {
  const r = parseVoiceCommand('show me john');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'open_chat');
  assert.equal(r.args.chatName, 'john');
});

test('close_chat: synonym "exit chat"', () => {
  const r = parseVoiceCommand('exit chat');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'close_chat');
});

test('search: synonym "find"', () => {
  const r = parseVoiceCommand('find birthday photos');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'search');
  assert.equal(r.args.query, 'birthday photos');
});

test('search: synonym "look for"', () => {
  const r = parseVoiceCommand('look for the invoice');
  assert.equal(r.ok, true);
  assert.equal(r.args.query, 'the invoice');
});

test('change_setting: synonym alias "dark mode" maps to theme', () => {
  const r = parseVoiceCommand('set dark mode to on');
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, { setting: 'theme', value: 'on' });
});

// ---- overlaps / longest-match determinism --------------------------------

test('longest phrase wins: "open chat" beats "open"', () => {
  const r = parseVoiceCommand('open chat the weekend crew');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'open_chat');
  assert.equal(r.args.chatName, 'the weekend crew');
});

test('longest phrase wins: "search for" beats "search"', () => {
  const r = parseVoiceCommand('search for old messages');
  assert.equal(r.ok, true);
  assert.equal(r.args.query, 'old messages');
});

test('ambiguous: two commands share the longest-matching trigger', () => {
  // temporarily prove ambiguity detection using a crafted registry snapshot
  const clash = [
    { id: 'cmd_a', synonyms: ['do thing'], argMode: 'none' },
    { id: 'cmd_b', synonyms: ['do thing'], argMode: 'none' },
  ];
  assert.throws(() => validateRegistry(clash), /claimed by both/);
});

// ---- missing / malformed args -------------------------------------------

test('open_chat: incomplete without chat name', () => {
  const r = parseVoiceCommand('open chat');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete');
});

test('close_chat: malformed with trailing words', () => {
  const r = parseVoiceCommand('close chat now please');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('send_message: malformed without "saying" keyword', () => {
  const r = parseVoiceCommand('send message to mom hello there');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('send_message: incomplete with empty message after "saying"', () => {
  const r = parseVoiceCommand('send message saying');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('forward_message: incomplete without target chat', () => {
  const r = parseVoiceCommand('forward this');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete');
});

test('forward_message: malformed without "to" keyword', () => {
  const r = parseVoiceCommand('forward this john');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('change_setting: malformed without "to" keyword', () => {
  const r = parseVoiceCommand('set theme dark');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('change_setting: unknown setting name fails closed', () => {
  const r = parseVoiceCommand('set favorite color to blue');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
});

test('unknown transcript produces no command', () => {
  const r = parseVoiceCommand('what is the weather today');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
});

test('empty transcript is incomplete', () => {
  const r = parseVoiceCommand('');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete');
});

// ---- blocked / destructive actions ---------------------------------------

test('blocked: change_setting cannot touch password', () => {
  const r = parseVoiceCommand('change setting password to hunter2');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('blocked: log out is never a voice action', () => {
  const r = parseVoiceCommand('log me out');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('blocked: log in is never a voice action', () => {
  const r = parseVoiceCommand('log in as admin');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('blocked: account deletion is never a voice action', () => {
  const r = parseVoiceCommand('delete my account');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('blocked: chat pin/lock changes are never a voice action', () => {
  const r = parseVoiceCommand('change setting chat pin to 1234');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('blocked: clearing history is never a voice action', () => {
  const r = parseVoiceCommand('clear chat history');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

test('blocked: admin actions are never a voice action', () => {
  const r = parseVoiceCommand('open admin panel');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blocked');
});

// ---- punctuation / case ---------------------------------------------------

test('case-insensitive and punctuation-tolerant matching', () => {
  const r = parseVoiceCommand('OPEN CHAT, Mom!');
  assert.equal(r.ok, true);
  assert.equal(r.command, 'open_chat');
  assert.equal(r.args.chatName, 'mom');
});

test('extra whitespace is collapsed', () => {
  const r = parseVoiceCommand('  search   for    old   receipts  ');
  assert.equal(r.ok, true);
  assert.equal(r.args.query, 'old receipts');
});

test('apostrophes in names are preserved', () => {
  const r = parseVoiceCommand("open chat o'brien");
  assert.equal(r.ok, true);
  assert.equal(r.args.chatName, "o'brien");
});

// ---- registry-only synonym extension --------------------------------------

test('registry-only extension: a new synonym works without touching the parser', () => {
  const extendedCommands = COMMANDS.map((c) =>
    c.id === 'open_chat' ? { ...c, synonyms: [...c.synonyms, 'jump to'] } : c
  );
  // The extended registry must still validate cleanly (no clashes introduced).
  assert.doesNotThrow(() => validateRegistry(extendedCommands));
});

test('registry-only extension: duplicate synonym across commands is rejected', () => {
  const clashing = COMMANDS.map((c) =>
    c.id === 'search' ? { ...c, synonyms: [...c.synonyms, 'open'] } : c
  );
  assert.throws(() => validateRegistry(clashing), /claimed by both/);
});
