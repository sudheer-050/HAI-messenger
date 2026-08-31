/**
 * Carve-out guard unit tests (MYAG-197)
 * Run with: node --test carve-out.unit.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCarveOut, isDenied } = require('./carve-out');

test('allows a routine change that touches none of the denylisted paths', () => {
    const result = checkCarveOut(['frontend/admin.html', 'README.md', 'jobboard/server.js']);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.blockedFiles, []);
});

test('blocks a change touching backend/server.js', () => {
    const result = checkCarveOut(['backend/server.js']);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.blockedFiles, ['backend/server.js']);
});

test('blocks a change touching frontend/index.html', () => {
    const result = checkCarveOut(['frontend/index.html']);
    assert.equal(result.allowed, false);
});

test('blocks .env and .env.example', () => {
    assert.equal(checkCarveOut(['.env']).allowed, false);
    assert.equal(checkCarveOut(['.env.example']).allowed, false);
});

test('blocks any file under cloudflared/, not just config.yml', () => {
    assert.equal(checkCarveOut(['cloudflared/config.yml']).allowed, false);
    assert.equal(checkCarveOut(['cloudflared/cert.pem']).allowed, false);
    assert.equal(checkCarveOut(['cloudflared/new-tunnel-creds.json']).allowed, false);
});

test('a denylisted file bundled with unrelated files still blocks the whole change', () => {
    const result = checkCarveOut(['frontend/admin.html', 'backend/server.js', 'README.md']);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.blockedFiles, ['backend/server.js']);
});

test('does not false-positive on files that merely share a name prefix', () => {
    // backend/server.js.bak, backend/server.js-notes.md, frontend/index.html.orig
    // are NOT the denylisted files themselves -- exact match only for files,
    // prefix match only for directories.
    const result = checkCarveOut(['backend/server.js.bak', 'frontend/index.html.orig']);
    assert.equal(result.allowed, true);
});

test('checkCarveOut blocks a rename when BOTH the pre- and post-rename path are given', () => {
    // checkCarveOut only ever sees the path list it's handed -- it has no
    // notion of "renamed from". A rename that keeps the crypto/relay logic
    // (backend/server.js -> backend/app.js) is only caught if the caller's
    // changed-file list includes both names. That is changed-files.js's job
    // (see changed-files.unit.test.js for the real git-fixture regression
    // test using a real rename) -- this test only pins checkCarveOut's own
    // contract: given both sides, either one being denylisted blocks the
    // whole change.
    const result = checkCarveOut(['backend/app.js', 'backend/server.js']);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.blockedFiles, ['backend/server.js']);
});

test('checkCarveOut alone cannot catch a rename given ONLY the post-rename path', () => {
    // This is the MYAG-203 bypass, isolated to this function: if the caller
    // only supplies the destination path (what `git diff --name-only` does),
    // checkCarveOut has nothing to catch it with -- it correctly reports
    // "allowed" for a list that, taken at face value, touches no denylisted
    // path. The fix is not here; it's making sure no caller ever builds that
    // incomplete a list (changed-files.js).
    const result = checkCarveOut(['backend/app.js']);
    assert.equal(result.allowed, true);
});

test('isDenied treats Windows-style separators the same as POSIX', () => {
    assert.equal(isDenied('cloudflared\\config.yml'), true);
    assert.equal(isDenied('backend\\server.js'), true);
});

test('empty or malformed input is treated as no changes (allowed, nothing to check)', () => {
    assert.deepEqual(checkCarveOut([]), { allowed: true, blockedFiles: [] });
    assert.deepEqual(checkCarveOut(undefined), { allowed: true, blockedFiles: [] });
    assert.equal(checkCarveOut(['', null, 'README.md']).allowed, true);
});

test('blocks docker-compose.yml and backend/Dockerfile (indirect secret-write vector via build config)', () => {
    // MYAG-203 reproduction: a change to an "allowed" build script can be
    // edited to write .env/key material during build. Denylisting the
    // Dockerfile and compose file directly closes that specific vector.
    assert.equal(checkCarveOut(['docker-compose.yml']).allowed, false);
    assert.equal(checkCarveOut(['backend/Dockerfile']).allowed, false);
});

test('blocks any file under deploy/, including the fast-path tooling itself', () => {
    // The carve-out guard (this file), orchestrator.js, deploy.sh, etc. are
    // themselves under deploy/mika-fastpath/. Without this, a fast-path
    // change could edit carve-out.js to weaken/disable the denylist for the
    // very diff being checked (MYAG-203).
    assert.equal(checkCarveOut(['deploy/mika-fastpath/carve-out.js']).allowed, false);
    assert.equal(checkCarveOut(['deploy/mika-fastpath/orchestrator.js']).allowed, false);
    assert.equal(checkCarveOut(['deploy/mika-fastpath/deploy.sh']).allowed, false);
});

test('blocks any file under .github/ (CI workflow config)', () => {
    assert.equal(checkCarveOut(['.github/workflows/mika-fastpath.yml']).allowed, false);
});

test('a custom denylist can be supplied without losing exact/prefix semantics', () => {
    const denylist = ['secret/', 'foo.txt'];
    assert.equal(checkCarveOut(['secret/nested/key.pem'], denylist).allowed, false);
    assert.equal(checkCarveOut(['foo.txt'], denylist).allowed, false);
    assert.equal(checkCarveOut(['foo.txt.bak'], denylist).allowed, true);
});
