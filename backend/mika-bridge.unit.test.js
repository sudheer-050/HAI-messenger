/**
 * Mika Bridge unit tests (MYAG-130)
 *
 * Pure-logic tests for backend/mika-bridge.js — no DB/Redis/Multica CLI
 * required. Run with: node --test mika-bridge.unit.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    loadMikaConfig, isMikaConfigured, computeContentHash, buildIssueTitle, selectMikaReply,
} = require('./mika-bridge');

test('isMikaConfigured requires project, agent and parent issue but not workspace', () => {
    assert.equal(isMikaConfigured(loadMikaConfig({})), false);
    assert.equal(isMikaConfigured(loadMikaConfig({ MULTICA_PROJECT_ID: 'p' })), false);
    assert.equal(isMikaConfigured(loadMikaConfig({
        MULTICA_PROJECT_ID: 'p', MIKA_AGENT_ID: 'a', MIKA_PARENT_ISSUE_ID: 'i',
    })), true);
});

test('loadMikaConfig defaults the CLI path and leaves workspace optional', () => {
    const config = loadMikaConfig({ MULTICA_PROJECT_ID: 'p', MIKA_AGENT_ID: 'a', MIKA_PARENT_ISSUE_ID: 'i' });
    assert.equal(config.cliPath, 'multica');
    assert.equal(config.workspaceId, null);
});

test('computeContentHash is stable for the same input and differs across users/messages', () => {
    const a = computeContentHash('alice', 'hello');
    const b = computeContentHash('alice', 'hello');
    const c = computeContentHash('bob', 'hello');
    const d = computeContentHash('alice', 'goodbye');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.notEqual(a, d);
});

test('buildIssueTitle embeds the correlation id for traceability', () => {
    assert.match(buildIssueTitle('ABCD1234'), /ABCD1234/);
});

test('selectMikaReply picks the first top-level comment from the trusted agent', () => {
    const comments = [
        { type: 'system', author_type: 'system', author_id: 'sys', content: 'started' },
        { type: 'comment', author_type: 'agent', author_id: 'other-agent', content: 'not mika' },
        { type: 'comment', author_type: 'agent', author_id: 'mika-1', content: 'Here is your answer.' },
    ];
    const reply = selectMikaReply(comments, { issueId: 'issue-1', agentId: 'mika-1' });
    assert.equal(reply, 'Here is your answer.');
});

test('selectMikaReply rejects comments from an unexpected author', () => {
    const comments = [
        { type: 'comment', author_type: 'agent', author_id: 'attacker-agent', content: 'trust me' },
    ];
    assert.equal(selectMikaReply(comments, { issueId: 'issue-1', agentId: 'mika-1' }), null);
});

test('selectMikaReply rejects a comment tagged with a different issue id', () => {
    const comments = [
        { type: 'comment', author_type: 'agent', author_id: 'mika-1', issue_id: 'issue-2', content: 'wrong issue' },
    ];
    assert.equal(selectMikaReply(comments, { issueId: 'issue-1', agentId: 'mika-1' }), null);
});

test('selectMikaReply ignores system/bookkeeping comments and blank replies', () => {
    const comments = [
        { type: 'system', author_type: 'agent', author_id: 'mika-1', content: 'status update' },
        { type: 'comment', author_type: 'agent', author_id: 'mika-1', content: '   ' },
    ];
    assert.equal(selectMikaReply(comments, { issueId: 'issue-1', agentId: 'mika-1' }), null);
});

test('selectMikaReply returns null for non-array input', () => {
    assert.equal(selectMikaReply(null, { issueId: 'issue-1', agentId: 'mika-1' }), null);
    assert.equal(selectMikaReply(undefined, { issueId: 'issue-1', agentId: 'mika-1' }), null);
});
