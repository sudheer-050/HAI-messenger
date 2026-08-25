// Regression coverage for MYAG-152: the voice bridge's `close chat` command
// calls exitMobileChatView()/animateChatClose(), which live inline in
// index.html (no build step). We pull the real function source out of the
// file and run it against a hand-rolled DOM stub so a regression in either
// viewport path fails a test instead of only showing up in manual QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const html = readFileSync(indexPath, 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in frontend/index.html`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function loadCloseFns({ document, window, CSS, currentActiveUser, currentNearbyMatchId, renderSidebarContacts }) {
  const src = `${extractFunction('animateChatClose')}\n${extractFunction('exitMobileChatView')}\nreturn { animateChatClose, exitMobileChatView };`;
  const factory = new Function('document', 'window', 'CSS', 'currentActiveUser', 'currentNearbyMatchId', 'renderSidebarContacts', src);
  return factory(document, window, CSS, currentActiveUser, currentNearbyMatchId, renderSidebarContacts);
}

function makeClassList(initial = []) {
  const set = new Set(initial);
  return { add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)), contains: c => set.has(c) };
}

function makeChatPanel() {
  const listeners = {};
  return {
    style: {},
    classList: makeClassList(),
    addEventListener(type, handler) { listeners[type] = handler; },
    removeEventListener(type) { delete listeners[type]; },
    fireTransitionEnd() { listeners.transitionend?.({ propertyName: 'transform' }); },
  };
}

test('close chat clears the active chat on desktop (viewport > 768px)', () => {
  const chatPanel = makeChatPanel();
  const bodyClassList = makeClassList(['mobile-chat-open']);
  let renderCalls = 0;
  const { exitMobileChatView } = loadCloseFns({
    document: { getElementById: id => (id === 'chatPanel' ? chatPanel : null), querySelectorAll: () => [], querySelector: () => null, body: { classList: bodyClassList } },
    window: { innerWidth: 1024 },
    CSS: { escape: s => s },
    currentActiveUser: 'alex',
    currentNearbyMatchId: null,
    renderSidebarContacts: () => { renderCalls++; },
  });

  let closed = false;
  exitMobileChatView(() => { closed = true; });

  assert.equal(closed, true, 'onClosed must fire so the bridge can clear currentActiveUser and show the empty state');
  assert.equal(bodyClassList.contains('mobile-chat-open'), false);
  assert.equal(renderCalls, 1);
});

test('close chat clears the active chat on mobile (viewport <= 768px) once the shrink animation settles', () => {
  const chatPanel = makeChatPanel();
  const bodyClassList = makeClassList(['mobile-chat-open']);
  const row = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 50, height: 50 }) };
  let renderCalls = 0;
  const { exitMobileChatView } = loadCloseFns({
    document: { getElementById: id => (id === 'chatPanel' ? chatPanel : null), querySelectorAll: () => [], querySelector: sel => (sel.includes('alex') ? row : null), body: { classList: bodyClassList } },
    window: { innerWidth: 375 },
    CSS: { escape: s => s },
    currentActiveUser: 'alex',
    currentNearbyMatchId: null,
    renderSidebarContacts: () => { renderCalls++; },
  });

  let closed = false;
  exitMobileChatView(() => { closed = true; });
  assert.equal(closed, false, 'the animated mobile path must not close instantly, before the shrink transition runs');

  chatPanel.fireTransitionEnd();
  assert.equal(closed, true);
  assert.equal(bodyClassList.contains('mobile-chat-open'), false);
  assert.equal(renderCalls, 1);
});
