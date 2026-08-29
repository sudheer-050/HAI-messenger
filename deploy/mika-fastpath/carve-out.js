/**
 * Mika fast-path carve-out guard (MYAG-197)
 *
 * Deterministic file-path check, not a heuristic: a change is blocked from
 * the fast path if any changed file falls under the denylist below,
 * regardless of what the commit message, PR title, or admin request says.
 * Whole files are denylisted (not "the crypto functions inside them") on
 * purpose -- distinguishing "crypto lines" from "other lines" in the same
 * file via diff/AST inspection is exactly the kind of heuristic that can be
 * bypassed by refactoring, renaming, or splitting a change across commits.
 * A path check cannot be bypassed that way.
 */
'use strict';

const path = require('path');

// Exact files and directory prefixes that always route to the normal
// review pipeline instead of the fast path.
const DEFAULT_DENYLIST = [
    'backend/server.js',
    'frontend/index.html',
    '.env',
    '.env.example',
    'cloudflared/',
];

function normalize(filePath) {
    return filePath.split(path.win32.sep).join('/').replace(/^\.\//, '');
}

function isDenied(filePath, denylist = DEFAULT_DENYLIST) {
    const normalized = normalize(filePath);
    return denylist.some(entry => {
        if (entry.endsWith('/')) return normalized.startsWith(entry);
        return normalized === entry;
    });
}

// changedFiles: array of repo-relative path strings (from `git diff --name-only`,
// a PR's file list, etc). Renames must be passed as their post-rename path
// AND pre-rename path (both sides of a rename can matter) -- callers should
// pass both `git diff --name-only` results (which already lists both names
// for a rename in most git versions) rather than only the new name.
function checkCarveOut(changedFiles, denylist = DEFAULT_DENYLIST) {
    const files = Array.isArray(changedFiles) ? changedFiles : [];
    const blockedFiles = files.filter(f => typeof f === 'string' && f.length > 0 && isDenied(f, denylist));
    return {
        allowed: blockedFiles.length === 0,
        blockedFiles,
    };
}

module.exports = { DEFAULT_DENYLIST, checkCarveOut, isDenied };
