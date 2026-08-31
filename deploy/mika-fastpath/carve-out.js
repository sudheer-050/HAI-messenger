/**
 * Mika fast-path carve-out guard (MYAG-197, hardened in MYAG-203)
 *
 * Deterministic file-path check, not a heuristic: a change is blocked from
 * the fast path if any changed file falls under the denylist below,
 * regardless of what the commit message, PR title, or admin request says.
 * Whole files are denylisted (not "the crypto functions inside them") on
 * purpose -- distinguishing "crypto lines" from "other lines" in the same
 * file via diff/AST inspection is exactly the kind of heuristic that can be
 * bypassed by refactoring, renaming, or splitting a change across commits.
 * A path check cannot be bypassed that way -- PROVIDED the caller feeds it
 * every path a change actually touches. Renames are the classic way to
 * violate that precondition (see `changed-files.js`): this module trusts
 * its input list and only checks paths, so getting a complete, both-sides
 * list of changed paths (renames/copies included) is the caller's job, not
 * this one's -- see `changed-files.js` for that half of the guarantee.
 *
 * The denylist below also covers files that CONTROL the build/deploy
 * pipeline itself (Dockerfile, docker-compose.yml, this `deploy/` directory)
 * rather than only files that directly hold secrets. A build step or the
 * fast-path tooling can be edited to write/exfiltrate secrets or to weaken
 * this very guard (MYAG-203) just as effectively as editing
 * `backend/server.js` directly, so those paths get the same treatment.
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
    // Build/deploy control surface: these don't hold secrets directly, but
    // can be edited to make a build step (Docker RUN, npm script, compose
    // env block, ...) write or exfiltrate them, or to weaken this guard.
    'docker-compose.yml',
    'backend/Dockerfile',
    'deploy/',
    '.github/',
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

// changedFiles: array of repo-relative path strings. For a rename/copy, BOTH
// the pre- and post-change path must be present in this list -- either can
// be the carved-out one. `git diff --name-only` does NOT provide this: it
// only ever prints the destination path of a rename, never the source, no
// matter the git version or rename-detection settings. Use
// `changed-files.js`'s `getChangedFiles` (which parses `--name-status -M -C`
// instead) to build this list from a real diff; this function does not
// re-derive renames from a plain path list on its own (MYAG-203).
function checkCarveOut(changedFiles, denylist = DEFAULT_DENYLIST) {
    const files = Array.isArray(changedFiles) ? changedFiles : [];
    const blockedFiles = files.filter(f => typeof f === 'string' && f.length > 0 && isDenied(f, denylist));
    return {
        allowed: blockedFiles.length === 0,
        blockedFiles,
    };
}

module.exports = { DEFAULT_DENYLIST, checkCarveOut, isDenied };
