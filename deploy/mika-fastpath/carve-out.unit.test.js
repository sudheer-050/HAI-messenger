/**
 * Carve-out guard unit tests (MYAG-197)
 * Run with: node --test carve-out.unit.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCarveOut, isDenied } = require('./carve-out');

test('allows a routine change that touches none of the denylisted paths', () => {
    const result = checkCarveOut(['frontend/admin.html', 'docker-compose.yml', 'jobboard/server.js']);
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
    const result = checkCarveOut(['frontend/admin.html', 'backend/server.js', 'docker-compose.yml']);
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

test('cannot be bypassed by renaming: the guard checks paths, not commit messages', () => {
    // A change that renames backend/server.js to backend/server-v2.js and edits
    // it there would not be caught by this path list alone -- that's an
    // inherent limit of a denylist (it protects the paths, not "the same
    // logical file forever"). What the guard DOES guarantee is that it never
    // trusts the commit message/PR description to decide -- only real changed
    // paths matter, so quoting "no crypto changes here" in a commit message
    // touching backend/server.js does not help.
    const result = checkCarveOut(['backend/server.js']);
    assert.equal(result.allowed, false);
});

test('isDenied treats Windows-style separators the same as POSIX', () => {
    assert.equal(isDenied('cloudflared\\config.yml'), true);
    assert.equal(isDenied('backend\\server.js'), true);
});

test('empty or malformed input is treated as no changes (allowed, nothing to check)', () => {
    assert.deepEqual(checkCarveOut([]), { allowed: true, blockedFiles: [] });
    assert.deepEqual(checkCarveOut(undefined), { allowed: true, blockedFiles: [] });
    assert.equal(checkCarveOut(['', null, 'docker-compose.yml']).allowed, true);
});

test('a custom denylist can be supplied without losing exact/prefix semantics', () => {
    const denylist = ['secret/', 'foo.txt'];
    assert.equal(checkCarveOut(['secret/nested/key.pem'], denylist).allowed, false);
    assert.equal(checkCarveOut(['foo.txt'], denylist).allowed, false);
    assert.equal(checkCarveOut(['foo.txt.bak'], denylist).allowed, true);
});
