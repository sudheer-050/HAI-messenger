import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContact } from './voice-controller.js';

test('resolution requires one exact username or label', () => {
  const contacts = [{ username: 'sam', label: 'Sam' }, { username: 'alex1', label: 'Alex' }];
  assert.deepEqual(resolveContact('SAM', contacts), { ok: true, contact: contacts[0] });
  assert.equal(resolveContact('sa', contacts).reason, 'not_found');
});

test('duplicate display labels fail closed', () => {
  const result = resolveContact('Alex', [{ username: 'alex1', label: 'Alex' }, { username: 'alex2', label: 'Alex' }]);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.matches.length, 2);
});

function makeElement() {
  const listeners = {};
  return {
    hidden: false, dataset: {}, textContent: '',
    setAttribute() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    dispatch(type, event = {}) { listeners[type]?.(event); },
  };
}

async function loadControllerWithForwardTarget(target) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const documentEvents = {};
  globalThis.document = { hidden: false, addEventListener: (type, fn) => { documentEvents[type] = fn; } };
  globalThis.window = { addEventListener() {} };
  const { createVoiceController } = await import(`./voice-controller.js?test=${Math.random()}`);
  const elements = Object.fromEntries(['panel','mic','status','confirm','summary','approve','dismiss','cancel'].map(key => [key, makeElement()]));
  const calls = [];
  class Adapter extends EventTarget {
    constructor() { super(); Adapter.last = this; }
    ready = true;
    listening = false;
    async start() { this.listening = true; }
    stop() { this.listening = false; }
  }
  const bridge = {
    getContacts: () => [{ username: 'sam', label: 'Sam' }],
    getActiveChat: () => 'alex',
    getForwardTarget: () => target,
    describe: () => 'confirm',
    forward: (...args) => calls.push(args),
  };
  const controller = createVoiceController({ bridge, elements, Adapter });
  await controller.start();
  const transcript = new Event('transcript');
  Object.defineProperty(transcript, 'detail', { value: { text: 'forward selected message to sam' } });
  Adapter.last.dispatchEvent(transcript);
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  return { controller, elements, calls };
}

test('forward captures the explicitly selected older message before confirmation', async () => {
  const result = await loadControllerWithForwardTarget({ messageId: 'older-message' });
  assert.equal(result.controller.state, 'confirming');
  assert.deepEqual(result.calls, []);
  result.elements.approve.dispatch('click');
  assert.deepEqual(result.calls, [['sam', 'older-message']]);
});

test('forward without a selected/current message fails before confirmation', async () => {
  const result = await loadControllerWithForwardTarget(null);
  assert.equal(result.controller.state, 'error');
  assert.match(result.elements.status.textContent, /Select a message/);
  assert.equal(result.elements.confirm.hidden, true);
  assert.deepEqual(result.calls, []);
});

test('dismissing forward confirmation has zero forwarding side effects', async () => {
  const result = await loadControllerWithForwardTarget({ messageId: 'older-message' });
  result.elements.dismiss.dispatch('click');
  assert.equal(result.controller.state, 'idle');
  assert.deepEqual(result.calls, []);
});
