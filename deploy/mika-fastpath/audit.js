/**
 * Mika fast-path audit trail (MYAG-197)
 *
 * Every fast-path attempt -- allowed-and-deployed, allowed-but-rolled-back,
 * or rejected by the carve-out -- produces exactly one audit record. This
 * module only formats that record and posts it; the caller decides which
 * issue it goes on. Posting reuses the `multica` CLI the Mika bridge already
 * requires to be installed/authenticated in the backend image (see
 * backend/mika-bridge.js and .env.example) -- this does not add a new
 * credential surface.
 */
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function formatAuditComment({
    outcome, // 'deployed' | 'rolled_back' | 'rollback_unverified' | 'rollback_failed' | 'rejected'
    correlationId,
    adminRequestSummary,
    changedFiles = [],
    blockedFiles = [],
    healthCheck = null,
    rollbackHealthCheck = null,
    rollbackError = null,
    rerouteError = null,
    error = null,
}) {
    const lines = [];
    const headline = {
        deployed: 'Fast-path deploy succeeded',
        rolled_back: 'Fast-path deploy failed health check -- rolled back and restoration verified',
        rollback_unverified: 'Fast-path deploy failed health check -- rollback ran but restoration is UNVERIFIED',
        rollback_failed: 'Fast-path deploy failed health check -- rollback itself FAILED',
        rejected: 'Fast-path rejected -- routed to normal review',
    }[outcome] || `Fast-path result: ${outcome}`;

    lines.push(`### ${headline}`);
    if (correlationId) lines.push(`**Correlation ID:** \`${correlationId}\``);
    lines.push('');
    lines.push(`**Admin request:** ${adminRequestSummary || '(not provided)'}`);

    if (changedFiles.length) {
        lines.push('');
        lines.push('**Changed files:**');
        for (const f of changedFiles) lines.push(`- \`${f}\``);
    }

    if (outcome === 'rejected') {
        lines.push('');
        lines.push('**Blocked by the crypto/secrets carve-out:**');
        for (const f of blockedFiles) lines.push(`- \`${f}\``);
        lines.push('');
        if (rerouteError) {
            lines.push(`**The normal-review issue could NOT be filed automatically:** ${rerouteError}`);
            lines.push('');
            lines.push('This change was still blocked and nothing was built or deployed, but a human needs to manually file the reroute issue -- it was not created.');
        } else {
            lines.push('A normal issue has been filed for a human/specialist to handle this change through the standard review pipeline. Nothing was built or deployed.');
        }
    }

    if (outcome === 'deployed') {
        lines.push('');
        lines.push('**Health check:** passed');
        if (healthCheck) {
            for (const r of healthCheck.results) lines.push(`- ${r.name} (\`${r.path}\`): ok`);
        }
    }

    if (outcome === 'rolled_back' || outcome === 'rollback_unverified' || outcome === 'rollback_failed') {
        lines.push('');
        lines.push('**Health check:** failed post-deploy -- automatic rollback to the last known-good version was attempted.');
        if (healthCheck) {
            for (const r of healthCheck.results) {
                lines.push(`- ${r.name} (\`${r.path}\`): ${r.ok ? 'ok' : `FAILED (${r.detail || 'no detail'})`}`);
            }
        }
    }

    if (outcome === 'rolled_back') {
        lines.push('');
        lines.push('**Post-rollback health check:** passed. The prior working deployment has been restored and this was verified, not assumed.');
        if (rollbackHealthCheck) {
            for (const r of rollbackHealthCheck.results) {
                lines.push(`- ${r.name} (\`${r.path}\`): ${r.ok ? 'ok' : `FAILED (${r.detail || 'no detail'})`}`);
            }
        }
    }

    if (outcome === 'rollback_unverified') {
        lines.push('');
        lines.push('**Post-rollback health check:** ALSO FAILED. `rollback.sh` reported success, but the restored service is not actually healthy -- restoration could NOT be verified. Do not assume the prior working version is serving traffic. Manual intervention required.');
        if (rollbackHealthCheck) {
            for (const r of rollbackHealthCheck.results) {
                lines.push(`- ${r.name} (\`${r.path}\`): ${r.ok ? 'ok' : `FAILED (${r.detail || 'no detail'})`}`);
            }
        }
    }

    if (outcome === 'rollback_failed') {
        lines.push('');
        lines.push('**Rollback:** `rollback.sh` itself failed -- no restoration was performed. The broken deploy may still be live. Manual intervention required immediately.');
        if (rollbackError) lines.push(`- rollback error: ${rollbackError}`);
    }

    if (error) {
        lines.push('');
        lines.push(`**Error:** ${error}`);
    }

    return lines.join('\n');
}

function runMulticaCli(cliPath, args) {
    return new Promise((resolve, reject) => {
        execFile(cliPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`${cliPath} ${args.join(' ')} failed: ${stderr || err.message}`));
            resolve(stdout);
        });
    });
}

// Writes the body to a workdir-local temp file first, per the platform's
// comment-formatting rule (never inline --content for agent-authored bodies).
async function postAuditComment({ cliPath = 'multica', issueId, body, parentCommentId, workdir = process.cwd() }) {
    const tmpPath = path.join(workdir, `.mika-fastpath-audit-${Date.now()}.md`);
    fs.writeFileSync(tmpPath, body, 'utf8');
    try {
        const args = ['issue', 'comment', 'add', issueId, '--content-file', tmpPath];
        if (parentCommentId) args.push('--parent', parentCommentId);
        return await runMulticaCli(cliPath, args);
    } finally {
        fs.unlinkSync(tmpPath);
    }
}

async function fileNormalIssue({ cliPath = 'multica', title, descriptionPath, projectId }) {
    const args = ['issue', 'create', '--title', title, '--description-file', descriptionPath, '--status', 'todo'];
    if (projectId) args.push('--project', projectId);
    return runMulticaCli(cliPath, args);
}

// Last-resort durable record for when the audit comment itself could not be
// posted to Multica (CLI outage, bad issue id, timeout, ...). MYAG-194's
// acceptance criterion is "every fast-path attempt produces an auditable
// record" -- if the platform is unreachable that has to degrade to a local
// file an operator can find and replay, not silence (MYAG-205).
const DEFAULT_OUTBOX_DIR = path.join(__dirname, '.audit-outbox');

function writeAuditOutbox({ correlationId, issueId, body, postError, outboxDir = DEFAULT_OUTBOX_DIR }) {
    fs.mkdirSync(outboxDir, { recursive: true });
    const outboxPath = path.join(
        outboxDir,
        `${Date.now()}-${(correlationId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')}.md`
    );
    const record = [
        '<!--',
        ' Mika fast-path audit record that could NOT be delivered to Multica.',
        ` issueId: ${issueId || '(unknown)'}`,
        ` correlationId: ${correlationId || '(unknown)'}`,
        ` capturedAt: ${new Date().toISOString()}`,
        ` postError: ${postError || '(unknown)'}`,
        '-->',
        '',
        body,
        '',
    ].join('\n');
    fs.writeFileSync(outboxPath, record, 'utf8');
    return outboxPath;
}

module.exports = { formatAuditComment, postAuditComment, fileNormalIssue, runMulticaCli, writeAuditOutbox };
