/**
 * Mika admin-only chat UI — static contract tests (MYAG-129)
 *
 * The frontend has no build step and no DOM test harness (no jsdom/puppeteer in this
 * repo), so these are static assertions against frontend/index.html and
 * frontend/service-worker.js rather than a rendered-DOM test. They exist to catch the
 * specific regressions that would silently break the security/UX contract this issue
 * cares about: an admin-only feature drifting into a code path a non-admin client also
 * runs, or Mika's history/content quietly starting to get cached on disk.
 *
 * Run with: node --test mika-ui.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const swJs = fs.readFileSync(path.join(__dirname, 'service-worker.js'), 'utf8');

test('index.html is well-formed JS inside its single <script> block', () => {
    const matches = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(matches.length, 1, 'expected exactly one inline <script> block (no-build-step convention)');
    assert.doesNotThrow(() => new Function(matches[0][1]));
});

test('the Mika sidebar row is gated on isAdmin, not just hidden by default', () => {
    assert.match(indexHtml, /if\s*\(isAdmin\s*&&\s*contactFilterMode === 'all'\)\s*{\s*\n\s*const mikaDiv/);
});

test('sending a message while currentMikaMode is active never falls through to the E2E send path', () => {
    const fnMatch = indexHtml.match(/async function sendPrivateMessage\(\)\s*{([\s\S]*?)\n {4}}/);
    assert.ok(fnMatch, 'sendPrivateMessage() not found');
    const body = fnMatch[1];
    const mikaIdx = body.indexOf('if (currentMikaMode) return sendMikaMessage();');
    const nearbyIdx = body.indexOf('if (currentNearbyMatchId) return sendNearbyMessage();');
    assert.ok(mikaIdx !== -1, 'sendPrivateMessage must short-circuit to sendMikaMessage()');
    assert.ok(mikaIdx < nearbyIdx, 'the Mika branch must be checked before any other send path runs');
});

test('the Mika request/reply endpoints and socket event match the backend contract exactly', () => {
    assert.match(indexHtml, /authFetchJSON\('\/api\/admin\/mika\/message', 'POST', \{ message: text \}\)/);
    assert.match(indexHtml, /authFetchJSON\('\/api\/admin\/mika\/requests', 'GET'\)/);
    assert.match(indexHtml, /socket\.on\('mika_reply', \(\{ requestId, correlationId, status, reply, error \}\) => {/);
});

test('Mika request/reply history is never written to localStorage or IndexedDB', () => {
    const sectionMatch = indexHtml.match(/\/\* MIKA BRIDGE — admin-only chat with Mika[\s\S]*?(?=\n {4}\/\* MOBILE "MORPH")/);
    assert.ok(sectionMatch, 'Mika bridge section not found');
    const section = sectionMatch[0];
    assert.doesNotMatch(section, /localStorage\.setItem/);
    assert.doesNotMatch(section, /idbSet\(/);
    assert.doesNotMatch(section, /persistConversations\(/);
    assert.doesNotMatch(section, /conversationHistory\[/, 'Mika must stay out of conversationHistory so search/cache/export code paths never see it');
});

test('Mika history is refetched from the authorized endpoint on every admin session start', () => {
    assert.match(indexHtml, /if \(isAdmin\) \{ renderSidebarContacts\(\); loadMikaRequests\(\); \}/);
});

test('logging out clears admin state and the Mika row in memory (no stale isAdmin leak to the next login)', () => {
    const fnMatch = indexHtml.match(/function closeSecureTunnel\(\)\s*{([\s\S]*?)\n {4}}/);
    assert.ok(fnMatch, 'closeSecureTunnel() not found');
    const body = fnMatch[1];
    assert.match(body, /isAdmin = false;/);
    assert.match(body, /mikaRequests = \[\];/);
    assert.match(body, /currentMikaMode = false;/);
});

test('failed/timed-out Mika requests expose a retry affordance instead of silently dropping', () => {
    assert.match(indexHtml, /retryMikaRequest\(req\.message\)/);
    assert.match(indexHtml, /function retryMikaRequest\(text\)/);
});

test('the friend-gate banner (1:1-only concept) is force-hidden while a Mika chat is open', () => {
    assert.match(indexHtml, /\.chat-area\.mika-mode > \.friend-gate-banner[\s\S]*?display: none !important;/);
});

test('service-worker.js still never caches anything (Mika endpoints must stay network-only, not just untouched)', () => {
    assert.match(swJs, /cache:\s*'no-store'/);
    assert.doesNotMatch(swJs, /caches\.(open|match)/);
});
