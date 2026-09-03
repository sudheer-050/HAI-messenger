/**
 * Voice calling unit tests (MYAG-220)
 *
 * Pure-logic tests for backend/calls.js — no DB/Redis/Socket.IO required.
 * Run with: node --test calls.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    loadTurnConfig, isTurnConfigured, mintTurnCredentials, otherParty, createCallManager,
} = require('./calls');

test('isTurnConfigured requires secret, realm and at least one url', () => {
    assert.equal(isTurnConfigured(loadTurnConfig({})), false);
    assert.equal(isTurnConfigured(loadTurnConfig({ TURN_SHARED_SECRET: 's' })), false);
    assert.equal(isTurnConfigured(loadTurnConfig({ TURN_SHARED_SECRET: 's', TURN_REALM: 'r' })), false);
    assert.equal(isTurnConfigured(loadTurnConfig({
        TURN_SHARED_SECRET: 's', TURN_REALM: 'r', TURN_URLS: 'turn:myserver:3478',
    })), true);
});

test('mintTurnCredentials returns null when TURN is not configured', () => {
    assert.equal(mintTurnCredentials(loadTurnConfig({}), 'alice'), null);
});

test('mintTurnCredentials embeds a future expiry and an HMAC-derived password', () => {
    const config = loadTurnConfig({
        TURN_SHARED_SECRET: 'top-secret', TURN_REALM: 'hai.example', TURN_URLS: 'turn:myserver:3478',
        TURN_CREDENTIAL_TTL_SECONDS: '120',
    });
    const now = () => 1_700_000_000_000;
    const creds = mintTurnCredentials(config, 'alice', { now });
    assert.equal(creds.username, `${Math.floor(now() / 1000) + 120}:alice`);
    assert.equal(creds.ttl, 120);
    assert.equal(creds.realm, 'hai.example');
    assert.deepEqual(creds.urls, ['turn:myserver:3478']);

    const crypto = require('node:crypto');
    const expectedPassword = crypto.createHmac('sha1', 'top-secret').update(creds.username).digest('base64');
    assert.equal(creds.password, expectedPassword);
});

test('mintTurnCredentials is useless after expiry: a stale username no longer matches a freshly derived password', () => {
    const config = loadTurnConfig({
        TURN_SHARED_SECRET: 'top-secret', TURN_REALM: 'hai.example', TURN_URLS: 'turn:myserver:3478',
        TURN_CREDENTIAL_TTL_SECONDS: '60',
    });
    const mintedAt = 1_700_000_000_000;
    const creds = mintTurnCredentials(config, 'alice', { now: () => mintedAt });
    // Re-minting far past the original expiry produces a different username (different
    // embedded expiry) and therefore a different password -- coturn itself independently
    // re-derives from the (expiry:userId) it's handed, so an old credential's password
    // simply won't validate against a current clock on the coturn side either.
    const laterCreds = mintTurnCredentials(config, 'alice', { now: () => mintedAt + 10 * 60 * 1000 });
    assert.notEqual(creds.username, laterCreds.username);
    assert.notEqual(creds.password, laterCreds.password);
});

test('otherParty resolves the counterpart or null for a stranger', () => {
    const call = { caller: 'alice', callee: 'bob' };
    assert.equal(otherParty(call, 'alice'), 'bob');
    assert.equal(otherParty(call, 'bob'), 'alice');
    assert.equal(otherParty(call, 'mallory'), null);
    assert.equal(otherParty(null, 'alice'), null);
});

function makeManager(overrides = {}) {
    const sockets = overrides.sockets || { bob: ['sock-bob'], alice: ['sock-alice'] };
    const contacts = overrides.contacts || new Set(['alice:bob']);
    return createCallManager({
        getUserSockets: async (username) => sockets[username] || [],
        isContact: async (a, b) => contacts.has([a, b].sort().join(':')),
        ringTimeoutMs: overrides.ringTimeoutMs ?? 30_000,
        now: overrides.now,
        onCallMissed: overrides.onCallMissed,
    });
}

test('inviteCall rejects a non-contact even if they are online', async () => {
    const manager = makeManager({ contacts: new Set() });
    const result = await manager.inviteCall('alice', 'bob');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_a_contact');
});

test('inviteCall rejects an offline contact', async () => {
    const manager = makeManager({ sockets: { alice: ['sock-alice'] } });
    const result = await manager.inviteCall('alice', 'bob');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'offline');
});

test('inviteCall rejects when the callee is already on another call (busy)', async () => {
    const manager = makeManager({
        sockets: { alice: ['a'], bob: ['b'], carol: ['c'] },
        contacts: new Set(['alice:bob', 'bob:carol']),
    });
    const first = await manager.inviteCall('bob', 'carol');
    assert.equal(first.ok, true);
    const second = await manager.inviteCall('alice', 'bob');
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'busy');
});

test('inviteCall rejects when the caller is already on another call', async () => {
    const manager = makeManager({
        sockets: { alice: ['a'], bob: ['b'], carol: ['c'] },
        contacts: new Set(['alice:bob', 'alice:carol']),
    });
    const first = await manager.inviteCall('alice', 'bob');
    assert.equal(first.ok, true);
    const second = await manager.inviteCall('alice', 'carol');
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'caller_busy');
});

test('happy path: invite -> accept transitions ringing -> active', async () => {
    const manager = makeManager();
    const { call } = await manager.inviteCall('alice', 'bob');
    assert.equal(call.status, 'ringing');
    const accepted = manager.acceptCall(call.callId, 'bob');
    assert.equal(accepted.ok, true);
    assert.equal(accepted.call.status, 'active');
    assert.equal(manager.getCall(call.callId).status, 'active');
});

test('only the callee can accept or decline', async () => {
    const manager = makeManager();
    const { call } = await manager.inviteCall('alice', 'bob');
    assert.equal(manager.acceptCall(call.callId, 'alice').ok, false);
    assert.equal(manager.declineCall(call.callId, 'alice').ok, false);
});

test('decline ends the call and frees both users to call again', async () => {
    const manager = makeManager();
    const { call } = await manager.inviteCall('alice', 'bob');
    const declined = manager.declineCall(call.callId, 'bob');
    assert.equal(declined.ok, true);
    assert.equal(declined.call.status, 'declined');
    assert.equal(manager.getCall(call.callId), null);
    assert.equal(manager.getUserActiveCall('alice'), null);
    assert.equal(manager.getUserActiveCall('bob'), null);
});

test('endCall from the caller while still ringing reports cancelled; after accept it reports ended', async () => {
    const manager = makeManager();
    const invited = await manager.inviteCall('alice', 'bob');
    const cancelled = manager.endCall(invited.call.callId, 'alice');
    assert.equal(cancelled.call.status, 'cancelled');

    const second = await manager.inviteCall('alice', 'bob');
    manager.acceptCall(second.call.callId, 'bob');
    const ended = manager.endCall(second.call.callId, 'bob');
    assert.equal(ended.call.status, 'ended');
});

test('a stranger cannot end someone else\'s call', async () => {
    const manager = makeManager({
        sockets: { alice: ['a'], bob: ['b'], mallory: ['m'] },
    });
    const { call } = await manager.inviteCall('alice', 'bob');
    assert.equal(manager.endCall(call.callId, 'mallory').ok, false);
});

test('an unanswered call auto-transitions to missed and never stays ringing', async () => {
    let missedCall = null;
    const manager = makeManager({
        ringTimeoutMs: 20,
        onCallMissed: (call) => { missedCall = call; },
    });
    const { call } = await manager.inviteCall('alice', 'bob');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(missedCall, 'onCallMissed should have fired');
    assert.equal(missedCall.callId, call.callId);
    assert.equal(missedCall.status, 'missed');
    assert.equal(manager.getCall(call.callId), null);
    assert.equal(manager.getUserActiveCall('alice'), null);
    assert.equal(manager.getUserActiveCall('bob'), null);
});

test('accepting before the ring timeout prevents the missed transition', async () => {
    let missedFired = false;
    const manager = makeManager({
        ringTimeoutMs: 20,
        onCallMissed: () => { missedFired = true; },
    });
    const { call } = await manager.inviteCall('alice', 'bob');
    manager.acceptCall(call.callId, 'bob');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(missedFired, false);
    assert.equal(manager.getCall(call.callId).status, 'active');
});

test('handleUserDisconnected cleans up a ringing call as missed', async () => {
    const manager = makeManager();
    const { call } = await manager.inviteCall('alice', 'bob');
    const ended = manager.handleUserDisconnected('bob');
    assert.equal(ended.status, 'missed');
    assert.equal(manager.getCall(call.callId), null);
});

test('handleUserDisconnected cleans up an active call as ended', async () => {
    const manager = makeManager();
    const { call } = await manager.inviteCall('alice', 'bob');
    manager.acceptCall(call.callId, 'bob');
    const ended = manager.handleUserDisconnected('alice');
    assert.equal(ended.status, 'ended');
    assert.equal(manager.getCall(call.callId), null);
});

test('handleUserDisconnected is a no-op for a user with no active call', () => {
    const manager = makeManager();
    assert.equal(manager.handleUserDisconnected('nobody'), null);
});
