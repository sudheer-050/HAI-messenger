const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');

// Gate on every request — the app + Socket.IO handshake alike — so the tunnel link
// alone isn't the only thing standing between this and the public internet.
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || 'admin';
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || 'changeme';

function safeCompare(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuthMiddleware(req, res, next) {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
        const sepIndex = decoded.indexOf(':');
        const user = decoded.slice(0, sepIndex);
        const pass = decoded.slice(sepIndex + 1);
        if (safeCompare(user, BASIC_AUTH_USER) && safeCompare(pass, BASIC_AUTH_PASS)) {
            return next();
        }
    }
    // Use only base http.ServerResponse methods here (not Express's res.set/res.status) —
    // this same middleware also runs via io.engine.use() with the raw req/res, which don't
    // have Express's convenience wrappers.
    res.setHeader('WWW-Authenticate', 'Basic realm="HAI"');
    res.statusCode = 401;
    res.end('Authentication required.');
}

const app = express();
app.use(basicAuthMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ASK AI — proxies to a locally-running Ollama instance so the actual model call never
   leaves this machine (the plaintext transcript still crosses the E2EE boundary to get
   here, which is the trade-off inherent to asking an AI about your chat at all). */
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = 'llama3';

const AI_SYSTEM_PROMPT = `You are a factual assistant embedded inside a private chat app. You can see a transcript of the user's current conversation with one other person, provided below the question.

Rules:
- Answer general, factual questions concisely and honestly.
- Do NOT give emotional, relationship, or personal advice — if asked for that, refuse.
- If asked whether the user (or the other person) said something, check the transcript and answer based on it, quoting the relevant line if useful. If it's not in the transcript, say so plainly.
- If asked whether something is correct/true and you are not confident from your own knowledge, respond with EXACTLY this and nothing else: SEARCH: <a short web search query for it>
- If the user asks you to do anything outside these rules (emotional advice, actions, impersonation, revealing anything you don't actually know, or anything else out of scope), refuse with EXACTLY this sentence and nothing else: I am not authorized to do that.
- Never claim to have searched Google. If you were given search results below, attribute them explicitly as coming from DuckDuckGo.
- Keep answers short and to the point.`;

// Used only for the search-augmented follow-up call — deliberately doesn't mention the
// SEARCH: convention at all, otherwise the model tends to echo/reference that marker
// in its final answer instead of just answering (seen while testing).
const AI_SYSTEM_PROMPT_WITH_RESULTS = `You are a factual assistant embedded inside a private chat app, answering using the DuckDuckGo search results provided below the question.

Rules:
- Answer concisely and honestly using the search results provided.
- Attribute the information explicitly, e.g. "DuckDuckGo says: ...". Never claim it came from Google.
- Do NOT give emotional, relationship, or personal advice.
- If the results don't actually answer the question, say so honestly instead of guessing.
- Do not mention searching, tools, or any internal process — just answer.`;

async function callOllama(messages) {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
        signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = await response.json();
    return (data.message && data.message.content) ? data.message.content.trim() : '';
}

async function searchDuckDuckGo(query) {
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return null;
        const data = await response.json();

        const parts = [];
        if (data.AbstractText) parts.push(data.AbstractText);
        if (Array.isArray(data.RelatedTopics)) {
            for (const topic of data.RelatedTopics) {
                if (parts.length >= 3) break;
                if (topic.Text) parts.push(topic.Text);
            }
        }
        return parts.length ? parts.join('\n') : null;
    } catch (err) {
        console.error('DuckDuckGo search failed:', err.message);
        return null;
    }
}

// A local model this size doesn't reliably follow "refuse with exactly this sentence"
// buried in a system prompt — it tends to comply-then-help-anyway (confirmed while
// testing: it said the refusal line, then gave the advice regardless). This keyword
// guard makes the refusal deterministic for the clearest cases instead of hoping the
// model listens; the system prompt is left in place as a second layer for the rest.
const EMOTIONAL_ADVICE_PATTERN = /\b(feel(ing)?s?\s+(sad|down|depress|anxious|lonely|hurt|upset)|depress(ed|ion)|anxiety|heartbrok|breakup|break[\s-]?up|relationship advice|should i (forgive|break up|leave|divorce)|(my|our) (relationship|marriage|boyfriend|girlfriend|husband|wife|partner))\b/i;

// "Is this correct/true" style verification questions should always search rather than
// hope the model asks for it — testing showed llama3 often just answers "I don't know"
// or guesses from training data instead of requesting a lookup, even when it clearly
// should. This makes the search step deterministic for exactly the phrasing the
// feature was asked for; the SEARCH: marker below still covers everything else.
const VERIFICATION_QUESTION_PATTERN = /\b(is (it|this|that) (true|correct|accurate|right)|is (that|this) correct|fact[\s-]?check|verify (that|this)|(current|latest|today'?s|recent) (news|price|weather|population|score|result|version))\b/i;

app.post('/api/ai/ask', async (req, res) => {
    const { question, transcript } = req.body || {};
    if (!question || typeof question !== 'string') {
        return res.status(400).json({ error: 'question is required' });
    }

    if (EMOTIONAL_ADVICE_PATTERN.test(question)) {
        return res.json({ answer: 'I am not authorized to do that.' });
    }

    const transcriptText = Array.isArray(transcript)
        ? transcript.map(m => `${m.sender}: ${m.text}`).join('\n')
        : '';

    const baseMessages = [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: `Conversation transcript:\n${transcriptText || '(no messages yet)'}\n\nQuestion: ${question}` }
    ];

    async function answerWithSearch(query) {
        const results = await searchDuckDuckGo(query);
        const messages = [
            { role: 'system', content: AI_SYSTEM_PROMPT_WITH_RESULTS },
            {
                role: 'user',
                content: results
                    ? `Conversation transcript:\n${transcriptText || '(no messages yet)'}\n\nQuestion: ${question}\n\nDuckDuckGo search results for "${query}":\n${results}`
                    : `Conversation transcript:\n${transcriptText || '(no messages yet)'}\n\nQuestion: ${question}\n\nA search for "${query}" returned no results. Tell the user you couldn't find current information on this and answer from what you already know, noting the uncertainty.`
            }
        ];
        return callOllama(messages);
    }

    let answer;
    try {
        if (VERIFICATION_QUESTION_PATTERN.test(question)) {
            answer = await answerWithSearch(question);
        } else {
            answer = await callOllama(baseMessages);
        }
    } catch (err) {
        console.error('Ollama call failed:', err.message);
        return res.status(502).json({ error: "AI assistant isn't reachable — make sure Ollama is running." });
    }

    // The model asks for a web lookup by replying with just this marker instead of an
    // answer — a lightweight, non-native alternative to real tool-calling that works
    // with any Ollama model regardless of tool-use support.
    const searchMatch = answer.match(/^SEARCH:\s*(.+)$/i);
    if (searchMatch) {
        try {
            answer = await answerWithSearch(searchMatch[1].trim());
        } catch (err) {
            console.error('Ollama follow-up call failed:', err.message);
            return res.status(502).json({ error: "AI assistant isn't reachable — make sure Ollama is running." });
        }
    }

    res.json({ answer });
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 8 * 1024 * 1024 // allow encrypted photo/voice-note/document payloads through
});
// Socket.IO's handshake is served by engine.io directly on the raw HTTP server, bypassing
// Express entirely — without this, someone could skip the login prompt and still open a socket.
io.engine.use(basicAuthMiddleware);

const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redisClient.connect().then(() => console.log('🌪️ Redis connected')).catch(err => console.error(err));

// Shared by send_private_message/edit_message/delete_message_everyone — holds any
// payload meant for a currently-offline user until they reconnect. Each payload carries
// a `kind` so the flush loop in register_user knows which event to replay it as.
async function queueForOfflineUser(username, payload) {
    const queueKey = `queue:${username}`;
    await redisClient.rPush(queueKey, JSON.stringify(payload));
    await redisClient.expire(queueKey, 60 * 60 * 24 * 30); // 30-day safety net for abandoned accounts
}

/* NEARBY — anonymous, 24h-expiring matches between whoever's currently online.
   Aliases are per-(viewer,target) so two different viewers never see the same handle
   for the same person, and the real username never reaches the other participant's
   client — only these Redis-side lookup keys know the mapping. */
const NEARBY_ADJECTIVES = ['Silent', 'Curious', 'Gentle', 'Swift', 'Quiet', 'Bright', 'Calm', 'Bold', 'Mellow', 'Vivid', 'Lucky', 'Hidden'];
const NEARBY_NOUNS = ['Fox', 'Falcon', 'Otter', 'Comet', 'Willow', 'Ember', 'Raven', 'Maple', 'Harbor', 'Cedar', 'Wren', 'Nova'];
const NEARBY_COLORS = ['#0d9488', '#e11d48', '#7c3aed', '#ea580c', '#0891b2', '#65a30d', '#c026d3', '#2563eb'];
function generateNearbyAlias() {
    const adj = NEARBY_ADJECTIVES[Math.floor(Math.random() * NEARBY_ADJECTIVES.length)];
    const noun = NEARBY_NOUNS[Math.floor(Math.random() * NEARBY_NOUNS.length)];
    const num = Math.floor(1000 + Math.random() * 9000);
    return {
        alias: `${adj} ${noun} #${num}`,
        color: NEARBY_COLORS[Math.floor(Math.random() * NEARBY_COLORS.length)]
    };
}
const NEARBY_ALIAS_TTL = 60 * 60 * 2; // 2h — stable alias window while browsing/mid-conversation
const NEARBY_MATCH_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Returns (generating if needed) the alias `viewer` sees for `target`, plus the
// reverse aliasId->target lookup used to resolve connect requests server-side.
async function getOrCreateNearbyAlias(viewer, target) {
    const fwdKey = `nearby:viewer:${viewer}:target:${target}`;
    const existing = await redisClient.get(fwdKey);
    if (existing) return JSON.parse(existing);

    const { alias, color } = generateNearbyAlias();
    const aliasId = crypto.randomUUID();
    const record = { aliasId, alias, color };

    await redisClient.set(fwdKey, JSON.stringify(record), { EX: NEARBY_ALIAS_TTL });
    await redisClient.set(`nearby:viewer:${viewer}:byalias:${aliasId}`, target, { EX: NEARBY_ALIAS_TTL });
    return record;
}

async function getActiveNearbyPeers(username) {
    const peers = new Set();
    const matchIds = await redisClient.sMembers('nearby:active_matches');
    for (const matchId of matchIds) {
        const raw = await redisClient.get(`nearby:match:${matchId}`);
        if (!raw) continue;
        const match = JSON.parse(raw);
        if (match.userA === username) peers.add(match.userB);
        else if (match.userB === username) peers.add(match.userA);
    }
    return peers;
}

async function expireNearbyMatch(matchId) {
    const raw = await redisClient.get(`nearby:match:${matchId}`);
    if (!raw) return;
    const match = JSON.parse(raw);
    await redisClient.del(`nearby:match:${matchId}`);
    await redisClient.sRem('nearby:active_matches', matchId);

    for (const username of [match.userA, match.userB]) {
        const socketId = await redisClient.get(`user:${username}:socket`);
        if (socketId) io.to(socketId).emit('nearby_match_expired', { matchId });
    }
}

// Sweeps every 5 minutes for matches past their 24h lifetime — deletes server state
// and tells both sides live if they're connected; the client also self-expires
// locally so a missed push (e.g. offline at the moment of expiry) still resolves
// itself the next time that client is open.
setInterval(async () => {
    try {
        const matchIds = await redisClient.sMembers('nearby:active_matches');
        const now = Date.now();
        for (const matchId of matchIds) {
            const raw = await redisClient.get(`nearby:match:${matchId}`);
            if (!raw) { await redisClient.sRem('nearby:active_matches', matchId); continue; }
            const match = JSON.parse(raw);
            if (match.expiresAt <= now) await expireNearbyMatch(matchId);
        }
    } catch (err) {
        console.error('Nearby expiry sweep failed:', err.message);
    }
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Map user to socket ID and store their public key string inside Redis
    socket.on('register_user', async (data) => {
        socket.username = data.username;
        await redisClient.set(`user:${data.username}:socket`, socket.id);
        await redisClient.set(`user:${data.username}:pubkey`, data.publicKey);

        // 🌟 FORCE REDIS INITIALIZATION: Automatically mark them online in the database right away
        await redisClient.set(`user:${data.username}:online`, 'true');
        await redisClient.set(`user:${data.username}:lastSeen`, Date.now().toString());
        await redisClient.sAdd('online_users', data.username);

        // Any of this user's Nearby matches that expired while they were away get
        // announced right now instead of silently lingering until the next sweep.
        const myMatchIds = await redisClient.sMembers('nearby:active_matches');
        for (const matchId of myMatchIds) {
            const raw = await redisClient.get(`nearby:match:${matchId}`);
            if (!raw) continue;
            const match = JSON.parse(raw);
            if ((match.userA === data.username || match.userB === data.username) && match.expiresAt <= Date.now()) {
                await expireNearbyMatch(matchId);
            }
        }

        // Broadcast to existing users that someone new arrived
        io.emit('presence_broadcast_update', {
            username: data.username,
            online: true,
            lastSeen: Date.now()
        });

        // Flush anything that arrived while this user was offline — new messages, edits,
        // and deletes all share this queue, replayed in order through the right event.
        const queueKey = `queue:${data.username}`;
        const queuedMessages = await redisClient.lRange(queueKey, 0, -1);
        for (const raw of queuedMessages) {
            const payload = JSON.parse(raw);

            if (payload.kind === 'edit') {
                socket.emit('message_edited', payload);
            } else if (payload.kind === 'delete') {
                socket.emit('message_deleted_everyone', payload);
            } else if (payload.kind === 'reaction') {
                socket.emit('message_reacted', payload);
            } else {
                socket.emit('receive_private_message', payload);
                const senderSocketId = await redisClient.get(`user:${payload.sender}:socket`);
                if (senderSocketId) {
                    io.to(senderSocketId).emit('message_status_update', { id: payload.id, peer: data.username, status: 'delivered' });
                }
            }
        }
        if (queuedMessages.length) {
            await redisClient.del(queueKey);
            console.log(`📤 Flushed ${queuedMessages.length} queued message(s) to ${data.username}`);
        }

        console.log(`🔒 Registered user ${data.username} with public key.`);
    });

    // Provide public keys AND current live status upon request!
    socket.on('get_user_public_key', async (username, callback) => {
        const pubKey = await redisClient.get(`user:${username}:pubkey`);
        
        // 🌟 TARGETED STATUS CHECK: Fetch their real-time state flags out of Redis directly
        const isOnlineStr = await redisClient.get(`user:${username}:online`);
        const lastSeenStr = await redisClient.get(`user:${username}:lastSeen`);
        
        const online = isOnlineStr === 'true';
        const lastSeen = lastSeenStr ? parseInt(lastSeenStr, 10) : Date.now();

        // Send a complete picture back to the requesting tab workspace
        callback(pubKey, { online, lastSeen });
    });

    // Route a locked payload to a specific socket ID destination
    socket.on('send_private_message', async (data) => {
        const targetSocketId = await redisClient.get(`user:${data.targetUsername}:socket`);

        const payload = {
            kind: 'message',
            id: data.id,
            sender: socket.username,
            encryptedMessage: data.encryptedMessage,
            replyToText: data.replyToText || null,
            replyToId: data.replyToId || null
        };

        if (targetSocketId) {
            io.to(targetSocketId).emit('receive_private_message', payload);
            // Recipient is connected right now, so the message is immediately "delivered"
            socket.emit('message_status_update', { id: data.id, peer: data.targetUsername, status: 'delivered' });
            console.log(`📬 Message successfully routed from ${socket.username} to ${data.targetUsername}`);
        } else {
            // Recipient is offline — hold the still-encrypted message until they reconnect
            await queueForOfflineUser(data.targetUsername, payload);
            console.log(`📥 ${data.targetUsername} is offline — message queued for delivery`);
        }
    });

    // Edit a previously-sent text message — same online/offline pattern as send_private_message
    socket.on('edit_message', async (data) => {
        if (!data.id || !data.targetUsername || !data.encryptedMessage) return;
        const targetSocketId = await redisClient.get(`user:${data.targetUsername}:socket`);
        const payload = { kind: 'edit', id: data.id, sender: socket.username, encryptedMessage: data.encryptedMessage };

        if (targetSocketId) {
            io.to(targetSocketId).emit('message_edited', payload);
        } else {
            await queueForOfflineUser(data.targetUsername, payload);
        }
    });

    // Delete a message for both participants — same online/offline pattern
    socket.on('delete_message_everyone', async (data) => {
        if (!data.id || !data.targetUsername) return;
        const targetSocketId = await redisClient.get(`user:${data.targetUsername}:socket`);
        const payload = { kind: 'delete', id: data.id, sender: socket.username };

        if (targetSocketId) {
            io.to(targetSocketId).emit('message_deleted_everyone', payload);
        } else {
            await queueForOfflineUser(data.targetUsername, payload);
        }
    });

    // React to a message with an emoji (or clear a reaction with emoji: null) —
    // same online/offline pattern as edit_message
    socket.on('react_message', async (data) => {
        if (!data.id || !data.targetUsername) return;
        const targetSocketId = await redisClient.get(`user:${data.targetUsername}:socket`);
        const payload = { kind: 'reaction', id: data.id, sender: socket.username, emoji: data.emoji || null };

        if (targetSocketId) {
            io.to(targetSocketId).emit('message_reacted', payload);
        } else {
            await queueForOfflineUser(data.targetUsername, payload);
        }
    });

    // In-chat mini-games (invite/accept/move/reset/leave) are relayed live only,
    // just like typing indicators — never queued, since a stale move replayed after
    // the recipient comes back online minutes later wouldn't make sense.
    socket.on('game_event', async (data) => {
        if (!data.targetUsername || !data.gameType || !data.payload) return;
        const targetSocketId = await redisClient.get(`user:${data.targetUsername}:socket`);
        if (targetSocketId) {
            io.to(targetSocketId).emit('game_event', { sender: socket.username, gameType: data.gameType, payload: data.payload });
        }
    });

    // NEARBY — anonymous, 24h-expiring matches with whoever else is online right now.
    // All handlers below relay live only (never queued), same rule as typing/game
    // events: a match only exists between two people who were just online together.
    socket.on('nearby_get_online_list', async (data, callback) => {
        if (typeof callback !== 'function') return;
        const me = socket.username;
        if (!me) return callback([]);

        const onlineUsers = await redisClient.sMembers('online_users');
        const activePeers = await getActiveNearbyPeers(me);
        const candidates = onlineUsers.filter(u => u !== me && !activePeers.has(u));

        const list = [];
        for (const target of candidates) {
            const record = await getOrCreateNearbyAlias(me, target);
            list.push({ aliasId: record.aliasId, alias: record.alias, color: record.color });
        }
        callback(list);
    });

    socket.on('nearby_send_request', async (data, callback) => {
        if (typeof callback !== 'function') callback = () => {};
        const me = socket.username;
        if (!me || !data || !data.toAliasId || !data.myEphemeralPubKey) return callback({ error: 'Invalid request' });

        const targetUsername = await redisClient.get(`nearby:viewer:${me}:byalias:${data.toAliasId}`);
        if (!targetUsername) return callback({ error: 'That person is no longer available.' });

        const targetSocketId = await redisClient.get(`user:${targetUsername}:socket`);
        if (!targetSocketId) return callback({ error: 'That person just went offline.' });

        const aliasOfMeForTarget = await getOrCreateNearbyAlias(targetUsername, me);
        const requestId = crypto.randomUUID();

        await redisClient.set(`nearby:request:${requestId}`, JSON.stringify({
            from: me,
            to: targetUsername,
            fromEphemeralPubKey: data.myEphemeralPubKey
        }), { EX: 60 * 10 }); // 10 minutes to respond before the request goes stale

        io.to(targetSocketId).emit('nearby_request_received', {
            requestId,
            fromAlias: aliasOfMeForTarget.alias,
            fromColor: aliasOfMeForTarget.color
        });
        callback({ ok: true, requestId });
    });

    socket.on('nearby_request_response', async (data, callback) => {
        if (typeof callback !== 'function') callback = () => {};
        const me = socket.username;
        if (!me || !data || !data.requestId) return callback({ error: 'Invalid response' });

        const raw = await redisClient.get(`nearby:request:${data.requestId}`);
        if (!raw) return callback({ error: 'That request has expired.' });
        const request = JSON.parse(raw);
        if (request.to !== me) return callback({ error: 'Not your request.' });
        await redisClient.del(`nearby:request:${data.requestId}`);

        const requesterSocketId = await redisClient.get(`user:${request.from}:socket`);

        if (!data.accept) {
            if (requesterSocketId) io.to(requesterSocketId).emit('nearby_request_declined', { requestId: data.requestId });
            return callback({ ok: true });
        }
        if (!data.myEphemeralPubKey) return callback({ error: 'Missing key material.' });
        if (!requesterSocketId) return callback({ error: 'They went offline before you accepted.' });

        const matchId = crypto.randomUUID();
        const expiresAt = Date.now() + NEARBY_MATCH_LIFETIME_MS;
        // aliasForA is the requester's view of me; aliasForB is my view of the requester.
        const aliasForA = await getOrCreateNearbyAlias(request.from, me);
        const aliasForB = await getOrCreateNearbyAlias(me, request.from);

        const match = {
            userA: request.from,
            userB: me,
            ephemeralPubKeyA: request.fromEphemeralPubKey,
            ephemeralPubKeyB: data.myEphemeralPubKey,
            aliasForA,
            aliasForB,
            expiresAt
        };
        await redisClient.set(`nearby:match:${matchId}`, JSON.stringify(match));
        await redisClient.sAdd('nearby:active_matches', matchId);

        // requestId is required on both emits — the client correlates this event back to
        // the ephemeral keypair it generated when it sent/accepted the request via
        // pendingNearbyRequests[requestId]. Omitting it (as this did originally) means
        // the match is created fine server-side but silently never appears on either
        // client, since the lookup on data.requestId always misses.
        io.to(requesterSocketId).emit('nearby_match_created', {
            matchId, requestId: data.requestId, alias: aliasForA.alias, color: aliasForA.color, expiresAt,
            theirEphemeralPubKey: data.myEphemeralPubKey
        });
        socket.emit('nearby_match_created', {
            matchId, requestId: data.requestId, alias: aliasForB.alias, color: aliasForB.color, expiresAt,
            theirEphemeralPubKey: request.fromEphemeralPubKey
        });
        callback({ ok: true, matchId });
    });

    socket.on('nearby_send_message', async (data, callback) => {
        if (typeof callback !== 'function') callback = () => {};
        const me = socket.username;
        if (!me || !data || !data.matchId || !data.encryptedMessage) return callback({ error: 'Invalid message' });

        const raw = await redisClient.get(`nearby:match:${data.matchId}`);
        if (!raw) return callback({ error: 'This chat has expired.' });
        const match = JSON.parse(raw);
        if (match.userA !== me && match.userB !== me) return callback({ error: 'Not your chat.' });
        if (match.expiresAt <= Date.now()) {
            await expireNearbyMatch(data.matchId);
            return callback({ error: 'This chat has expired.' });
        }

        const otherUser = match.userA === me ? match.userB : match.userA;
        const otherSocketId = await redisClient.get(`user:${otherUser}:socket`);
        if (otherSocketId) {
            io.to(otherSocketId).emit('nearby_message_received', { matchId: data.matchId, encryptedMessage: data.encryptedMessage });
        }
        callback({ ok: true, delivered: !!otherSocketId });
    });

    // Typing indicators are ephemeral — relay only if the recipient is online right now,
    // never queued, since a "was typing" notice minutes later is meaningless.
    socket.on('typing_start', async (data) => {
        if (!data.targetUsername) return;
        const targetSocketId = await redisClient.get(`user:${data.targetUsername}:socket`);
        if (targetSocketId) io.to(targetSocketId).emit('typing_start', { sender: socket.username });
    });
    socket.on('typing_stop', async (data) => {
        if (!data.targetUsername) return;
        const targetSocketId = await redisClient.get(`user:${data.targetUsername}:socket`);
        if (targetSocketId) io.to(targetSocketId).emit('typing_stop', { sender: socket.username });
    });

    // Relay read receipts back to the original sender
    socket.on('mark_message_read', async (data) => {
        if (!data.peer || !Array.isArray(data.messageIds)) return;
        const originalSenderSocketId = await redisClient.get(`user:${data.peer}:socket`);
        if (originalSenderSocketId) {
            data.messageIds.forEach(id => {
                io.to(originalSenderSocketId).emit('message_status_update', { id, peer: socket.username, status: 'read' });
            });
        }
    });

    // Manual presence status updates coming from frontend hooks
    socket.on('update_presence_status', async (data) => {
        if (!data.username) return;

        await redisClient.set(`user:${data.username}:online`, data.online ? 'true' : 'false');
        await redisClient.set(`user:${data.username}:lastSeen`, data.lastSeen.toString());

        io.emit('presence_broadcast_update', {
            username: data.username,
            online: data.online,
            lastSeen: data.lastSeen
        });
    });

    // Handle session termination cleanups
    socket.on('disconnect', async () => {
        if (socket.username) {
            const now = Date.now();

            await redisClient.set(`user:${socket.username}:online`, 'false');
            await redisClient.set(`user:${socket.username}:lastSeen`, now.toString());
            await redisClient.del(`user:${socket.username}:socket`);
            await redisClient.sRem('online_users', socket.username);

            io.emit('presence_broadcast_update', {
                username: socket.username,
                online: false,
                lastSeen: now
            });

            console.log(`🏃 User ${socket.username} has disconnected.`);
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 HAI server on port ${PORT}`));