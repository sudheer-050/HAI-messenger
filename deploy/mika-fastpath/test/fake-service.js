/**
 * Throwaway HTTP service for the fast-path integration test (MYAG-197).
 * Not part of the app -- stands in for "the deployed backend" so the real
 * health-check module can be exercised against a real HTTP server without
 * docker (unavailable in this sandbox).
 *
 * MODE=good   -> both paths behave correctly (this is "v1", the last-good version)
 * MODE=broken -> process stays up (no crash) but /api/theme silently breaks --
 *                the exact "broken but running" case a crash-restart can't catch.
 */
'use strict';
const http = require('http');

const mode = process.env.MODE === 'broken' ? 'broken' : 'good';
const port = Number(process.env.PORT || 4123);

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>ok</html>');
        return;
    }
    if (req.url === '/api/theme') {
        if (mode === 'good') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ theme: 'dark' }));
        } else {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('not json -- simulates a silently broken deploy');
        }
        return;
    }
    res.writeHead(404);
    res.end();
});

server.listen(port, () => {
    process.send && process.send({ ready: true, mode, port });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
