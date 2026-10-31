const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadWorker({ fetchImpl = async () => ({ source: 'network' }), matchImpl = async () => undefined } = {}) {
    const listeners = {};
    const cache = { addAll: async () => {} };
    const context = {
        URL,
        Promise,
        fetch: fetchImpl,
        caches: {
            open: async () => cache,
            keys: async () => [],
            delete: async () => true,
            match: matchImpl
        },
        self: {
            location: { origin: 'https://hai.test' },
            clients: { claim: async () => {} },
            skipWaiting: async () => {},
            addEventListener(type, listener) { listeners[type] = listener; }
        }
    };

    vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, 'service-worker.js'), 'utf8'),
        context
    );
    return { listeners, cache };
}

test('install precaches the app shell and local Socket.IO client', async () => {
    const { listeners, cache } = loadWorker();
    let shell;
    cache.addAll = async (paths) => { shell = paths; };
    let pending;
    listeners.install({ waitUntil(promise) { pending = promise; } });
    await pending;

    assert.ok(shell.includes('/index.html'));
    assert.ok(shell.includes('/manifest.json'));
    assert.ok(shell.includes('/socket.io/socket.io.js'));
});

test('offline navigation falls back to the cached app shell', async () => {
    const shellResponse = { source: 'app-shell' };
    const { listeners } = loadWorker({
        fetchImpl: async () => { throw new Error('offline'); },
        matchImpl: async (request) => request === '/index.html' ? shellResponse : undefined
    });
    let response;
    listeners.fetch({
        request: { method: 'GET', mode: 'navigate', url: 'https://hai.test/index.html' },
        respondWith(promise) { response = promise; }
    });

    assert.equal(await response, shellResponse);
});

test('dynamic API and Socket.IO connection requests remain network-only', () => {
    const { listeners } = loadWorker();
    for (const url of ['https://hai.test/api/messages', 'https://hai.test/socket.io/?EIO=4']) {
        let intercepted = false;
        listeners.fetch({
            request: { method: 'GET', mode: 'cors', url },
            respondWith() { intercepted = true; }
        });
        assert.equal(intercepted, false, url);
    }
});
