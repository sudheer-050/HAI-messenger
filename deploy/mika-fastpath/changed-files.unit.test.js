/**
 * changed-files.js git-fixture tests (MYAG-203)
 *
 * These build REAL throwaway git repos and perform REAL renames/copies with
 * `git mv` / `cp` + `git add`, then run the actual `getChangedFiles` against
 * them -- no mocking of git's diff output. This is the regression coverage
 * the MYAG-203 report explicitly asked for: a prior test claimed to prove
 * "cannot be bypassed by renaming" but never performed one.
 *
 * Run with: node --test deploy/mika-fastpath/changed-files.unit.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { getChangedFiles } = require('./changed-files');
const { checkCarveOut } = require('./carve-out');

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-fastpath-fixture-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    return { dir, git };
}

function writeFile(dir, relPath, content) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

test('getChangedFiles reports BOTH sides of a rename', () => {
    const { dir, git } = makeRepo();
    writeFile(dir, 'backend/server.js', 'x'.repeat(200) + '\nconsole.log("crypto stuff")\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    git('mv', 'backend/server.js', 'backend/app.js');
    writeFile(dir, 'backend/app.js', 'x'.repeat(200) + '\nconsole.log("crypto stuff, edited")\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'rename server.js to app.js');

    const files = getChangedFiles('HEAD~1', 'HEAD', { cwd: dir });
    assert.ok(files.includes('backend/server.js'), 'must include the pre-rename path');
    assert.ok(files.includes('backend/app.js'), 'must include the post-rename path');

    // End-to-end: the carve-out must still block this even though the file
    // now lives at an allowed-looking path.
    const carveOut = checkCarveOut(files);
    assert.equal(carveOut.allowed, false);
    assert.ok(carveOut.blockedFiles.includes('backend/server.js'));
});

test('getChangedFiles reports both sides of a rename bundled with unrelated changes', () => {
    const { dir, git } = makeRepo();
    writeFile(dir, 'backend/server.js', 'x'.repeat(200) + '\noriginal\n');
    writeFile(dir, 'frontend/admin.html', '<html></html>\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    git('mv', 'backend/server.js', 'backend/app.js');
    writeFile(dir, 'frontend/admin.html', '<html>changed</html>\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'bundled rename + routine edit');

    const files = getChangedFiles('HEAD~1', 'HEAD', { cwd: dir });
    assert.ok(files.includes('backend/server.js'));
    assert.ok(files.includes('backend/app.js'));
    assert.ok(files.includes('frontend/admin.html'));

    const carveOut = checkCarveOut(files);
    assert.equal(carveOut.allowed, false);
});

test('getChangedFiles reports both sides of a copy', () => {
    const { dir, git } = makeRepo();
    writeFile(dir, 'backend/server.js', 'x'.repeat(200) + '\noriginal\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    // A copy (not a rename) of a denylisted file into a fresh path -- the
    // source still exists too, so this is caught even without -C, but the
    // guard should still see the copy's destination explicitly.
    fs.copyFileSync(path.join(dir, 'backend/server.js'), path.join(dir, 'backend/server-copy.js'));
    writeFile(dir, 'backend/server-copy.js', fs.readFileSync(path.join(dir, 'backend/server.js'), 'utf8') + '\nmore\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'copy server.js');

    const files = getChangedFiles('HEAD~1', 'HEAD', { cwd: dir });
    assert.ok(files.includes('backend/server.js'), 'source of the copy must still be listed');
});

test('getChangedFiles on a routine change with no renames matches plain add/modify/delete', () => {
    const { dir, git } = makeRepo();
    writeFile(dir, 'frontend/admin.html', 'v1\n');
    writeFile(dir, 'jobboard/server.js', 'v1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    writeFile(dir, 'frontend/admin.html', 'v2\n');
    fs.unlinkSync(path.join(dir, 'jobboard/server.js'));
    writeFile(dir, 'README.md', 'new file\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'routine change');

    const files = getChangedFiles('HEAD~1', 'HEAD', { cwd: dir });
    assert.deepEqual(files.sort(), ['README.md', 'frontend/admin.html', 'jobboard/server.js']);

    const carveOut = checkCarveOut(files);
    assert.equal(carveOut.allowed, true);
});

test('build-script write vector: editing backend/Dockerfile is blocked (MYAG-203 repro step 4)', () => {
    const { dir, git } = makeRepo();
    writeFile(dir, 'backend/Dockerfile', 'FROM node:18-alpine\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    writeFile(dir, 'backend/Dockerfile', 'FROM node:18-alpine\nRUN echo $SECRET > .env\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'dockerfile writes .env at build time');

    const files = getChangedFiles('HEAD~1', 'HEAD', { cwd: dir });
    const carveOut = checkCarveOut(files);
    assert.equal(carveOut.allowed, false);
    assert.deepEqual(carveOut.blockedFiles, ['backend/Dockerfile']);
});

test('self-modification vector: editing the carve-out guard itself is blocked (MYAG-203)', () => {
    const { dir, git } = makeRepo();
    writeFile(dir, 'deploy/mika-fastpath/carve-out.js', 'module.exports = { DEFAULT_DENYLIST: [] };\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    writeFile(dir, 'deploy/mika-fastpath/carve-out.js', 'module.exports = { DEFAULT_DENYLIST: [], checkCarveOut: () => ({ allowed: true, blockedFiles: [] }) };\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'weaken the guard');

    const files = getChangedFiles('HEAD~1', 'HEAD', { cwd: dir });
    const carveOut = checkCarveOut(files);
    assert.equal(carveOut.allowed, false);
    assert.deepEqual(carveOut.blockedFiles, ['deploy/mika-fastpath/carve-out.js']);
});
