/**
 * Mika Bridge — pure helper functions (MYAG-130)
 *
 * Kept separate from server.js so the request-shaping and reply-selection
 * logic can be unit tested without a live DB/Redis/Multica CLI. Nothing in
 * this module performs I/O.
 */
'use strict';

const crypto = require('crypto');

function loadMikaConfig(env = process.env) {
    return {
        cliPath: env.MULTICA_CLI_PATH || 'multica',
        workspaceId: env.MULTICA_WORKSPACE_ID || null,
        projectId: env.MULTICA_PROJECT_ID || null,
        agentId: env.MIKA_AGENT_ID || null,
        parentIssueId: env.MIKA_PARENT_ISSUE_ID || null,
    };
}

// Workspace ID is optional (the CLI can already be bound to a single
// workspace via its own auth/profile) -- everything else is required for the
// bridge to know where to create issues and who to trust the reply from.
function isMikaConfigured(config) {
    return Boolean(config && config.projectId && config.agentId && config.parentIssueId);
}

function computeContentHash(username, message) {
    return crypto.createHash('sha256').update(`${username}:${message}`).digest('hex').slice(0, 32);
}

function buildIssueTitle(correlationId) {
    return `[HAI bridge ${correlationId}] Admin message`;
}

// Picks the first top-level comment authored by Mika's own agent id on the
// expected issue that isn't a system/bookkeeping entry -- a comment from any
// other author, or from the wrong issue, is never relayed to the admin as
// "Mika's answer".
function selectMikaReply(comments, { issueId, agentId } = {}) {
    if (!Array.isArray(comments) || !agentId) return null;
    const hit = comments.find(c =>
        c &&
        c.type === 'comment' &&
        c.author_type === 'agent' &&
        c.author_id === agentId &&
        (!issueId || !c.issue_id || c.issue_id === issueId) &&
        typeof c.content === 'string' &&
        c.content.trim().length > 0
    );
    return hit ? hit.content.trim() : null;
}

module.exports = {
    loadMikaConfig,
    isMikaConfigured,
    computeContentHash,
    buildIssueTitle,
    selectMikaReply,
};
