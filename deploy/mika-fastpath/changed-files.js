/**
 * Changed-file discovery for the Mika fast-path carve-out (MYAG-197, MYAG-203)
 *
 * `git diff --name-only` never reports the pre-rename/pre-copy source path,
 * only the destination -- so renaming a carved-out file (e.g.
 * `backend/server.js` -> `backend/app.js`, keeping the crypto/relay logic)
 * silently drops the carved-out path off the list the guard sees, even
 * though `-M`/`-C` rename detection is on by default for `git diff`.
 * `--name-status -M -C` instead reports both sides of a rename/copy as a
 * `R<score>\t<old-path>\t<new-path>` / `C<score>\t<old-path>\t<new-path>`
 * line, which is what the carve-out actually needs: both the path a change
 * moves a file FROM and the path it moves/copies it TO.
 */
'use strict';

const { execFileSync } = require('child_process');

// baseRef/headRef: git refs/SHAs to diff. cwd: repo root to run git in.
function getChangedFiles(baseRef, headRef, { cwd } = {}) {
    const out = execFileSync(
        'git',
        // --find-copies-harder: without it, `-C` only considers copy sources
        // among files ALSO modified in this diff -- a copy from an untouched
        // file (e.g. duplicating backend/server.js into a new "helper" file
        // without editing the original) would otherwise show up as a plain
        // add, with no link back to the denylisted source at all.
        ['diff', '--name-status', '-M', '-C', '--find-copies-harder', `${baseRef}..${headRef}`],
        { cwd, encoding: 'utf8' }
    );

    const files = new Set();
    for (const rawLine of out.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const parts = line.split('\t');
        const status = parts[0][0];
        if (status === 'R' || status === 'C') {
            // Rename/copy: <status>\t<old-path>\t<new-path> -- both sides
            // matter, this is exactly the bypass in MYAG-203.
            if (parts[1]) files.add(parts[1]);
            if (parts[2]) files.add(parts[2]);
        } else if (parts[1]) {
            files.add(parts[1]);
        }
    }
    return Array.from(files);
}

module.exports = { getChangedFiles };
