'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
    createConcurrencyLimiter,
    createEdgeSecurityMiddleware,
    envFlag,
    isBackupArtifactPath,
} = require('./security');

function responseDouble() {
    const res = new EventEmitter();
    res.headers = {};
    res.setHeader = (name, value) => { res.headers[name] = value; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.body = body; return res; };
    res.send = body => { res.body = body; return res; };
    res.redirect = (code, location) => { res.statusCode = code; res.location = location; return res; };
    return res;
}

test('Gemini fallback style flag is explicit opt-in', () => {
    assert.equal(envFlag(undefined), false);
    assert.equal(envFlag('false'), false);
    assert.equal(envFlag('0'), false);
    assert.equal(envFlag('true'), true);
    assert.equal(envFlag('1'), true);
});

test('edge middleware redirects HTTP to the configured canonical HTTPS origin', () => {
    const middleware = createEdgeSecurityMiddleware({ enforceHttps: true, publicOrigin: 'https://myhai.org' });
    const res = responseDouble();
    let nextCalled = false;
    middleware({ secure: false, headers: {}, originalUrl: '/h.html?mode=voice' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 308);
    assert.equal(res.location, 'https://myhai.org/h.html?mode=voice');
});

test('HTTPS redirect cannot be redirected to a request-supplied host', () => {
    const middleware = createEdgeSecurityMiddleware({ enforceHttps: true, publicOrigin: 'https://myhai.org' });
    const res = responseDouble();
    middleware({ secure: false, headers: { host: 'attacker.invalid' }, originalUrl: '//attacker.invalid/path' }, res, () => {
        assert.fail('HTTP request must redirect');
    });
    assert.equal(res.statusCode, 308);
    assert.equal(res.location, 'https://myhai.org/attacker.invalid/path');
});

test('edge middleware trusts the proxy result and applies compatible security headers', () => {
    const middleware = createEdgeSecurityMiddleware({ enforceHttps: true, publicOrigin: 'https://myhai.org' });
    const res = responseDouble();
    let nextCalled = false;
    middleware({ secure: true, headers: {}, originalUrl: '/' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.headers['Strict-Transport-Security'], 'max-age=31536000');
    assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.match(res.headers['Content-Security-Policy'], /https:\/\/cdn\.socket\.io/);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('backup artifacts are identified without blocking ordinary pages', () => {
    assert.equal(isBackupArtifactPath('/h.html.orig'), true);
    assert.equal(isBackupArtifactPath('/landing.html.bak-20260823'), true);
    assert.equal(isBackupArtifactPath('/assets/app.js.swp'), true);
    assert.equal(isBackupArtifactPath('/h.html'), false);
    assert.equal(isBackupArtifactPath('/.well-known/security.txt'), false);
});

test('concurrency limiter rejects excess work and releases capacity once', () => {
    const limit = createConcurrencyLimiter(1);
    const first = responseDouble();
    const second = responseDouble();
    let firstNext = false;
    let thirdNext = false;
    limit({}, first, () => { firstNext = true; });
    limit({}, second, () => assert.fail('second request must be rejected'));
    assert.equal(firstNext, true);
    assert.equal(second.statusCode, 503);
    assert.equal(second.headers['Retry-After'], '5');
    first.emit('finish');
    first.emit('close');
    limit({}, responseDouble(), () => { thirdNext = true; });
    assert.equal(thirdNext, true);
});
