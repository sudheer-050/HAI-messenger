/**
 * Voice calling — WebRTC signaling state + TURN credential minting (MYAG-220)
 *
 * Kept separate from server.js, same reasoning as tts.js: I/O (socket lookup,
 * contact checks, wall-clock time) is all injected so the call-state machine
 * and credential minting can be unit tested without a live Socket.IO/Redis/PG
 * stack. This module never sees or stores call audio — only call metadata
 * (who/when/how it ended) ever crosses out of here, via the onCallMissed hook
 * and the plain objects handlers return to the caller.
 */
'use strict';

const crypto = require('crypto');

const DEFAULT_RING_TIMEOUT_MS = 45 * 1000;
const DEFAULT_TURN_TTL_SECONDS = 600; // 10 minutes

function loadTurnConfig(env = process.env) {
    return {
        secret: env.TURN_SHARED_SECRET || null,
        realm: env.TURN_REALM || null,
        urls: String(env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
        ttlSeconds: Number(env.TURN_CREDENTIAL_TTL_SECONDS) > 0
            ? Number(env.TURN_CREDENTIAL_TTL_SECONDS)
            : DEFAULT_TURN_TTL_SECONDS,
    };
}

function isTurnConfigured(config) {
    return Boolean(config && config.secret && config.realm && config.urls.length);
}

// coturn's standard "TURN REST API" long-term-credential mechanism: username is
// "<expiryUnixSeconds>:<userId>", password is base64(HMAC-SHA1(sharedSecret, username)).
// coturn re-derives the same password from the embedded expiry plus its own copy of the
// secret, so nothing longer-lived than the TTL is ever stored server-side or handed to
// the client, and an expired username simply fails coturn's own HMAC check.
function mintTurnCredentials(config, userId, { now = Date.now } = {}) {
    if (!isTurnConfigured(config) || !userId) return null;
    const expiresAt = Math.floor(now() / 1000) + config.ttlSeconds;
    const username = `${expiresAt}:${userId}`;
    const password = crypto.createHmac('sha1', config.secret).update(username).digest('base64');
    return { username, password, ttl: config.ttlSeconds, expiresAt, realm: config.realm, urls: config.urls };
}

function otherParty(call, username) {
    if (!call) return null;
    if (call.caller === username) return call.callee;
    if (call.callee === username) return call.caller;
    return null;
}

/* Call state: ringing -> active -> ended (or ringing -> missed/declined/cancelled).
   All state lives in-memory (this app runs Socket.IO single-process, with no cross-
   instance adapter, so presence/socket routing is already process-local) and every
   ringing call carries its own timer, so nothing can be stuck ringing past
   ringTimeoutMs even if the server never hears back from either side. */
function createCallManager({
    getUserSockets,
    isContact,
    ringTimeoutMs = DEFAULT_RING_TIMEOUT_MS,
    now = Date.now,
    onCallMissed,
} = {}) {
    const calls = new Map();      // callId -> call record
    const userToCall = new Map(); // username -> callId, enforces one active call per user

    function getUserActiveCall(username) {
        const callId = userToCall.get(username);
        if (!callId) return null;
        return calls.get(callId) || null;
    }

    function clearRingTimer(call) {
        if (call.timer) {
            clearTimeout(call.timer);
            call.timer = null;
        }
    }

    function finalizeCall(call, status) {
        clearRingTimer(call);
        call.status = status;
        call.endedAt = now();
        calls.delete(call.callId);
        if (userToCall.get(call.caller) === call.callId) userToCall.delete(call.caller);
        if (userToCall.get(call.callee) === call.callId) userToCall.delete(call.callee);
        return { ...call };
    }

    async function inviteCall(caller, callee) {
        if (!caller || !callee || caller === callee) return { ok: false, reason: 'invalid_target' };
        if (getUserActiveCall(caller)) return { ok: false, reason: 'caller_busy' };
        if (getUserActiveCall(callee)) return { ok: false, reason: 'busy' };

        const contact = await isContact(caller, callee);
        if (!contact) return { ok: false, reason: 'not_a_contact' };

        const calleeSockets = await getUserSockets(callee);
        if (!calleeSockets.length) return { ok: false, reason: 'offline' };

        const callId = crypto.randomUUID();
        const call = { callId, caller, callee, status: 'ringing', createdAt: now(), timer: null };
        calls.set(callId, call);
        userToCall.set(caller, callId);
        userToCall.set(callee, callId);

        call.timer = setTimeout(() => {
            const current = calls.get(callId);
            if (!current || current.status !== 'ringing') return;
            const ended = finalizeCall(current, 'missed');
            if (typeof onCallMissed === 'function') onCallMissed(ended);
        }, ringTimeoutMs);
        if (typeof call.timer.unref === 'function') call.timer.unref();

        return { ok: true, call: { ...call } };
    }

    function acceptCall(callId, byUser) {
        const call = calls.get(callId);
        if (!call || call.callee !== byUser || call.status !== 'ringing') return { ok: false };
        clearRingTimer(call);
        call.status = 'active';
        call.activeAt = now();
        return { ok: true, call: { ...call } };
    }

    function declineCall(callId, byUser) {
        const call = calls.get(callId);
        if (!call || call.callee !== byUser || call.status !== 'ringing') return { ok: false };
        return { ok: true, call: finalizeCall(call, 'declined') };
    }

    function endCall(callId, byUser) {
        const call = calls.get(callId);
        if (!call || (call.caller !== byUser && call.callee !== byUser)) return { ok: false };
        const status = call.status === 'ringing' ? 'cancelled' : 'ended';
        return { ok: true, call: finalizeCall(call, status) };
    }

    // Last-device-disconnect cleanup: ends whatever call this user is in so the other
    // side never keeps waiting on someone who's gone. Returns null if they weren't in one.
    function handleUserDisconnected(username) {
        const call = getUserActiveCall(username);
        if (!call) return null;
        const status = call.status === 'ringing' ? 'missed' : 'ended';
        return finalizeCall(call, status);
    }

    function getCall(callId) {
        return calls.get(callId) || null;
    }

    return {
        inviteCall, acceptCall, declineCall, endCall,
        getCall, getUserActiveCall, handleUserDisconnected,
    };
}

module.exports = {
    DEFAULT_RING_TIMEOUT_MS, DEFAULT_TURN_TTL_SECONDS,
    loadTurnConfig, isTurnConfigured, mintTurnCredentials,
    otherParty, createCallManager,
};
