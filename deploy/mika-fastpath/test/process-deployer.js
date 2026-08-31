/**
 * Test-only stand-in for deploy.sh/rollback.sh (MYAG-197).
 *
 * Plays the same role docker image tagging does in production: `deploy(mode)`
 * remembers the currently-running mode as "last-good" before switching, and
 * `rollback()` restores it. Implemented as a plain child process swap because
 * this sandbox has no docker daemon access -- deploy.sh/rollback.sh must
 * still be validated against real docker (CI or the home server) before
 * being trusted; see README.md.
 */
'use strict';
const { fork } = require('child_process');
const path = require('path');

class ProcessDeployer {
    constructor(port) {
        this.port = port;
        this.current = null; // child process
        this.currentMode = null;
        this.lastGoodMode = null;
    }

    async deploy(mode) {
        if (this.current) {
            this.lastGoodMode = this.currentMode;
            await this._stop();
        }
        await this._start(mode);
        this.currentMode = mode;
    }

    async rollback() {
        if (!this.lastGoodMode) throw new Error('no last-good version to roll back to');
        await this._stop();
        await this._start(this.lastGoodMode);
        this.currentMode = this.lastGoodMode;
    }

    async _start(mode) {
        const child = fork(path.join(__dirname, 'fake-service.js'), [], {
            env: { ...process.env, MODE: mode, PORT: String(this.port) },
            silent: true,
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('service did not start in time')), 3000);
            child.once('message', (msg) => { clearTimeout(timer); resolve(msg); });
            child.once('error', reject);
        });
        this.current = child;
    }

    async _stop() {
        if (!this.current) return;
        this.current.kill('SIGTERM');
        await new Promise(resolve => this.current.once('exit', resolve));
        this.current = null;
    }

    async teardown() {
        await this._stop();
    }
}

module.exports = { ProcessDeployer };
