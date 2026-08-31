'use strict';

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.socket.io https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self' wss: https://en.wikipedia.org https://itunes.apple.com https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
].join('; ');

function envFlag(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function requestIsHttps(req) {
    return Boolean(req.secure);
}

function setSecurityHeaders(res, isHttps) {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function createEdgeSecurityMiddleware({ enforceHttps = false, publicOrigin = 'https://myhai.org' } = {}) {
    const canonicalOrigin = new URL(publicOrigin);
    if (canonicalOrigin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must use https');
    canonicalOrigin.pathname = '/';
    canonicalOrigin.search = '';
    canonicalOrigin.hash = '';

    return (req, res, next) => {
        const isHttps = requestIsHttps(req);
        setSecurityHeaders(res, isHttps);
        if (enforceHttps && !isHttps) {
            const requestPath = String(req.originalUrl || req.url || '/');
            const safePath = `/${requestPath.replace(/^\/+/, '')}`;
            return res.redirect(308, `${canonicalOrigin.origin}${safePath}`);
        }
        next();
    };
}

function isBackupArtifactPath(requestPath) {
    let pathname;
    try {
        pathname = decodeURIComponent(String(requestPath || '').split('?')[0]);
    } catch (_err) {
        return true;
    }
    return pathname.split('/').some(segment =>
        /\.(?:bak|backup|orig|old|save|swp|tmp)(?:[.-].*)?$/i.test(segment)
    );
}

function denyBackupArtifacts(req, res, next) {
    if (isBackupArtifactPath(req.path || req.url)) return res.status(404).send('Not found');
    next();
}

function createConcurrencyLimiter(maxConcurrent, options = {}) {
    const limit = Math.max(1, Number.parseInt(maxConcurrent, 10) || 1);
    const retryAfterSeconds = Math.max(1, Number.parseInt(options.retryAfterSeconds, 10) || 5);
    let active = 0;

    const middleware = (req, res, next) => {
        if (active >= limit) {
            res.setHeader('Retry-After', String(retryAfterSeconds));
            return res.status(503).json({ error: 'H is busy right now. Please try again in a moment.' });
        }
        active += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            active = Math.max(0, active - 1);
        };
        res.once('finish', release);
        res.once('close', release);
        next();
    };
    middleware.activeCount = () => active;
    return middleware;
}

module.exports = {
    CONTENT_SECURITY_POLICY,
    createConcurrencyLimiter,
    createEdgeSecurityMiddleware,
    denyBackupArtifacts,
    envFlag,
    isBackupArtifactPath,
    requestIsHttps,
};
