import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController, resolveContact } from './voice-controller.js';
import { SETTINGS_ALLOWLIST, SETTING_VALUES } from './commandRegistry.js';

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

class FakeElement {
  constructor() {
    this.hidden = true;
    this.dataset = {};
    this.textContent = '';
    this.listeners = {};
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute() {}
  click() { return this.listeners.click?.(); }
}

function elements() {
  return Object.fromEntries(
    ['panel', 'mic', 'status', 'confirm', 'summary', 'approve', 'dismiss', 'cancel']
      .map(key => [key, new FakeElement()])
  );
}

test('allowlisted setting aliases reach confirmation and execute their exact key/value', async () => {
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.window = { addEventListener() {} };

  for (const [alias, key] of Object.entries(SETTINGS_ALLOWLIST)) {
    for (const value of SETTING_VALUES[key]) {
      const calls = [];
      class Adapter {
        ready = true;
        listening = false;
        addEventListener(type, listener) { if (type === 'transcript') this.transcript = listener; }
        async start() {
          this.listening = true;
          this.transcript({ detail: { text: `change setting ${alias} to ${value}` } });
        }
        stop() { this.listening = false; }
      }
      const ui = elements();
      const bridge = {
        getContacts: () => [], getActiveChat: () => null,
        describe: () => 'confirm setting',
        changeSetting: (...args) => calls.push(args),
      };
      const controller = createVoiceController({ bridge, elements: ui, Adapter });
      await controller.start();
      assert.equal(controller.state, 'confirming', `${alias}=${value} did not confirm`);
      ui.approve.click();
      assert.deepEqual(calls, [[key, value]], `${alias}=${value} did not execute`);
    }
  }
});

test('invalid setting values never reach confirmation or execution', async () => {
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.window = { addEventListener() {} };

  for (const alias of Object.keys(SETTINGS_ALLOWLIST)) {
    const calls = [];
    class Adapter {
      ready = true;
      listening = false;
      addEventListener(type, listener) { if (type === 'transcript') this.transcript = listener; }
      async start() {
        this.listening = true;
        this.transcript({ detail: { text: `change setting ${alias} to definitely-invalid` } });
      }
      stop() { this.listening = false; }
    }
    const ui = elements();
    const controller = createVoiceController({
      Adapter, elements: ui,
      bridge: {
        getContacts: () => [], getActiveChat: () => null,
        describe: () => 'should not describe',
        changeSetting: (...args) => calls.push(args),
      },
    });
    await controller.start();
    assert.equal(controller.state, 'error', alias);
    assert.equal(ui.confirm.hidden, true, alias);
    assert.deepEqual(calls, [], alias);
  }
});

test('cancel and restart remove stale recognition listeners', async () => {
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  const calls = [];
  class Adapter extends EventTarget {
    constructor() { super(); Adapter.last = this; }
    ready = true;
    listening = false;
    async start() { this.listening = true; }
    stop() { this.listening = false; }
  }
  const controller = createVoiceController({
    Adapter,
    elements: elements(),
    bridge: {
      getContacts: () => [],
      getActiveChat: () => null,
      search: query => calls.push(query),
    },
  });

  await controller.start();
  controller.cancel();
  await controller.start();
  const transcript = new Event('transcript');
  Object.defineProperty(transcript, 'detail', { value: { text: 'search cats' } });
  Adapter.last.dispatchEvent(transcript);

  assert.deepEqual(calls, ['cats']);
  assert.equal(controller.state, 'idle');
});
