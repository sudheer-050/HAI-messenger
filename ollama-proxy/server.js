/* Tiny authenticated forwarder in front of local Ollama.
   Ollama itself has no auth -- exposing it directly through the Cloudflare
   Tunnel would let anyone who finds the hostname use it for free. This sits in
   between: it only forwards /api/chat, and only when the caller supplies the
   shared secret (OLLAMA_LOCAL_SECRET, matched against the Render backend's own
   copy of the same value) in the X-Proxy-Secret header. Nothing else is exposed. */
const express = require('express');
const app = express();

const PORT = process.env.PORT || 4001;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const PROXY_SECRET = process.env.PROXY_SECRET;

if (!PROXY_SECRET) {
    console.error('PROXY_SECRET is not set -- refusing to start (would otherwise expose Ollama with no auth).');
    process.exit(1);
}

app.use(express.json({ limit: '2mb' }));

// Unauthenticated health check only -- lets Cloudflare/uptime tools confirm the
// proxy itself is alive without touching Ollama or needing the secret.
app.get('/', (req, res) => res.json({ ok: true }));

app.post('/api/chat', async (req, res) => {
    if (req.headers['x-proxy-secret'] !== PROXY_SECRET) {
        return res.status(403).json({ error: 'forbidden' });
    }
    try {
        const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
        });
        const data = await upstream.json();
        res.status(upstream.status).json(data);
    } catch (err) {
        console.error('ollama-proxy forward failed:', err.message);
        res.status(502).json({ error: 'Ollama unreachable' });
    }
});

app.listen(PORT, () => console.log(`ollama-proxy listening on ${PORT}, forwarding to ${OLLAMA_URL}`));
