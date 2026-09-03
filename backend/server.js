const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { createTtsService } = require('./tts');
const {
    loadMikaConfig, isMikaConfigured, computeContentHash, buildIssueTitle, selectMikaReply,
} = require('./mika-bridge');
const {
    loadTurnConfig, isTurnConfigured, mintTurnCredentials, otherParty, createCallManager,
} = require('./calls');

const app = express();

// The only hop between this server and the internet is the cloudflared tunnel
// container on the same Docker network, so trusting exactly one proxy hop gives
// accurate per-visitor IPs (from X-Forwarded-For) without trusting arbitrary
// spoofed headers from further upstream. Without this, every visitor's request
// looks like it comes from the tunnel container's own address, so IP-based rate
// limits (login, signup, etc.) end up shared across all visitors combined
// instead of per-person.
app.set('trust proxy', 1);

// Gates every request to the site behind a single shared HTTP Basic Auth
// prompt -- this app has no per-visitor access control of its own before
// account signup, so without this the whole thing (including the AI chat
// endpoint, which costs real API quota per message) is open to the public.
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || null;
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || null;
if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
    const expectedUser = Buffer.from(BASIC_AUTH_USER);
    const expectedPass = Buffer.from(BASIC_AUTH_PASS);
    app.use((req, res, next) => {
        const header = req.headers.authorization || '';
        const [scheme, encoded] = header.split(' ');
        if (scheme === 'Basic' && encoded) {
            const decoded = Buffer.from(encoded, 'base64').toString('utf8');
            const sepIdx = decoded.indexOf(':');
            const user = Buffer.from(decoded.slice(0, sepIdx));
            const pass = Buffer.from(decoded.slice(sepIdx + 1));
            const userOk = user.length === expectedUser.length && crypto.timingSafeEqual(user, expectedUser);
            const passOk = pass.length === expectedPass.length && crypto.timingSafeEqual(pass, expectedPass);
            if (userOk && passOk) return next();
        }
        res.set('WWW-Authenticate', 'Basic realm="HAI"');
        res.status(401).send('Authentication required');
    });
}

app.use(express.json({ limit: '25mb' })); // encrypted email backups can be several MB base64-encoded
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), {
    // landing.html (marketing homepage) is what "/" resolves to now; the actual
    // app/login lives at the explicit /index.html path -- see manifest.json's
    // start_url, which deliberately points there instead of "/" so an installed
    // PWA opens straight into the app rather than the marketing page every time.
    index: 'landing.html',
    // Both landing.html and index.html are single always-changing files during
    // active development -- a browser silently serving a stale cached copy after
    // an edit (instead of a normal refresh picking up the new one) has repeatedly
    // looked identical to "the fix didn't work" from the user's side. Force them
    // to always revalidate; other static assets (icons etc.) keep default caching
    // since they don't change as often.
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html') || filePath.endsWith('landing.html')) {
            res.setHeader('Cache-Control', 'no-store, must-revalidate');
        }
    }
}));

/* REAL ACCOUNTS — Postgres-backed users, bcrypt-hashed passwords, email verification
   via Resend before an account can be created. JWT session tokens are issued on
   successful login/signup and are the only thing register_user trusts for identity. */
const JWT_SECRET = process.env.JWT_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_visible BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
`).then(async () => {
    console.log('🐘 Postgres users table ready');
    // One-time bootstrap: promote whoever's listed in ADMIN_USERNAMES (comma-separated)
    // to admin on every startup, so granting/revoking dashboard access is just an env
    // var + restart rather than a manual SQL command.
    const adminUsernames = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (adminUsernames.length) {
        try {
            await pgPool.query('UPDATE users SET is_admin = true WHERE username = ANY($1)', [adminUsernames]);
            console.log(`👑 Admin access granted to: ${adminUsernames.join(', ')}`);
        } catch (err) {
            console.error('Admin bootstrap failed:', err.message);
        }
    }
}).catch(err => console.error('Postgres init failed:', err.message));

/* ANALYTICS — lightweight metadata-only event log (never message content, which
   the server never sees anyway thanks to E2E encryption) that powers the admin
   dashboard. Every INSERT is fire-and-forget from the caller's perspective: a
   failure here should never break the real feature that triggered it. */
pgPool.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
        id BIGSERIAL PRIMARY KEY,
        event_type VARCHAR(40) NOT NULL,
        username VARCHAR(20),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS analytics_events_type_time_idx ON analytics_events (event_type, created_at);

    CREATE TABLE IF NOT EXISTS admin_dashboards (
        id VARCHAR(36) PRIMARY KEY,
        created_by VARCHAR(20) NOT NULL,
        name VARCHAR(100) NOT NULL,
        layout JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS admin_dashboards_created_by_idx ON admin_dashboards (created_by);

    CREATE TABLE IF NOT EXISTS admin_scheduled_reports (
        id VARCHAR(36) PRIMARY KEY,
        dashboard_id VARCHAR(36) NOT NULL REFERENCES admin_dashboards(id) ON DELETE CASCADE,
        created_by VARCHAR(20) NOT NULL,
        email VARCHAR(255) NOT NULL,
        frequency VARCHAR(10) NOT NULL DEFAULT 'weekly',
        last_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
`).then(() => console.log('📊 Postgres analytics tables ready')).catch(err => console.error('Postgres analytics init failed:', err.message));

/* MIKA BRIDGE correlation state (MYAG-130) — one row per admin message sent to
   Mika. Persisted (not just Redis) so a server restart mid-poll can resume
   in-flight requests instead of silently losing them, and so the admin UI can
   restore request/reply history across refresh/reconnect. */
pgPool.query(`
    CREATE TABLE IF NOT EXISTS mika_bridge_requests (
        id                UUID PRIMARY KEY,
        admin_username    VARCHAR(20) NOT NULL,
        content_hash      VARCHAR(64) NOT NULL,
        correlation_id    VARCHAR(16) NOT NULL,
        message           TEXT NOT NULL,
        multica_issue_id  VARCHAR(64),
        status            VARCHAR(12) NOT NULL DEFAULT 'pending',
        reply             TEXT,
        error             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mika_bridge_requests_admin_idx ON mika_bridge_requests (admin_username, created_at DESC);
    CREATE INDEX IF NOT EXISTS mika_bridge_requests_hash_idx ON mika_bridge_requests (content_hash, created_at DESC);
    CREATE INDEX IF NOT EXISTS mika_bridge_requests_status_idx ON mika_bridge_requests (status);
`).then(() => {
    console.log('🌉 Postgres Mika bridge table ready');
    recoverPendingMikaRequests();
}).catch(err => console.error('Postgres Mika bridge init failed:', err.message));

pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_theme_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
`).then(() => console.log('🎨 Postgres theme settings table ready')).catch(err => console.error('Postgres theme init failed:', err.message));

// Fire-and-forget metadata-only event log -- never awaited by the caller's own
// success path, so a logging failure can't take down the feature that called it.
function logAnalyticsEvent(eventType, username) {
    pgPool.query('INSERT INTO analytics_events (event_type, username) VALUES ($1, $2)', [eventType, username || null])
        .catch(err => console.error(`analytics log failed (${eventType}):`, err.message));
}

// Same posture as requireAuth, plus an is_admin check against Postgres (admin
// panel traffic is low-volume, so a query per request is fine -- no need to cache
// this in Redis/JWT the way presence data is).
async function requireAdmin(req, res, next) {
    try {
        const result = await pgPool.query('SELECT is_admin FROM users WHERE username = $1', [req.username]);
        if (!result.rows.length || !result.rows[0].is_admin) {
            return res.status(403).json({ error: 'Admin access required.' });
        }
        next();
    } catch (err) {
        console.error('requireAdmin check failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
}

/* FRIENDS — messaging is gated behind an accepted friend request (see send_private_message
   below). Friendships are stored as one canonical row per pair (user_a < user_b
   alphabetically) so there's never a duplicate/reversed row to reconcile. */
pgPool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
        id SERIAL PRIMARY KEY,
        from_user VARCHAR(20) NOT NULL,
        to_user VARCHAR(20) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        responded_at TIMESTAMPTZ,
        note VARCHAR(300)
    );
    ALTER TABLE friend_requests ADD COLUMN IF NOT EXISTS note VARCHAR(300);
    CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_pair_idx
        ON friend_requests (from_user, to_user) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS friend_requests_to_user_idx ON friend_requests (to_user, status);
    CREATE INDEX IF NOT EXISTS friend_requests_from_user_idx ON friend_requests (from_user, status);

    CREATE TABLE IF NOT EXISTS friendships (
        user_a VARCHAR(20) NOT NULL,
        user_b VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_a, user_b)
    );
`).then(() => console.log('🤝 Postgres friends tables ready')).catch(err => console.error('Postgres friends init failed:', err.message));

/* GROUPS — membership/roles/permissions live here in Postgres (the only place any
   server-side "who's in this conversation" state exists), but message CONTENT never
   does: exactly like 1:1 chat, the server only ever relays already-encrypted
   payloads and never stores them. A group message is encrypted once per current
   member (client-side, reusing the same RSA-OAEP+AES-GCM envelope as a 1:1 message)
   and fanned out -- see send_group_message below -- rather than using a shared
   group key, so this reuses the exact crypto/relay/offline-queue machinery 1:1
   chat already has instead of a separate protocol. */
pgPool.query(`
    CREATE TABLE IF NOT EXISTS groups (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        avatar TEXT,
        created_by VARCHAR(20) NOT NULL,
        only_admins_can_send BOOLEAN NOT NULL DEFAULT false,
        only_admins_can_manage BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS group_members (
        group_id VARCHAR(36) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        username VARCHAR(20) NOT NULL,
        role VARCHAR(10) NOT NULL DEFAULT 'member',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (group_id, username)
    );
    CREATE INDEX IF NOT EXISTS group_members_username_idx ON group_members (username);
    CREATE TABLE IF NOT EXISTS group_invites (
        code VARCHAR(24) PRIMARY KEY,
        group_id VARCHAR(36) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        created_by VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ,
        revoked BOOLEAN NOT NULL DEFAULT false
    );
`).then(() => console.log('👥 Postgres groups tables ready')).catch(err => console.error('Postgres groups init failed:', err.message));

async function getGroupMembers(groupId) {
    const r = await pgPool.query('SELECT username, role FROM group_members WHERE group_id = $1 ORDER BY joined_at ASC', [groupId]);
    return r.rows;
}
// null if not a member, otherwise their role ('member' | 'admin').
async function getGroupRole(groupId, username) {
    const r = await pgPool.query('SELECT role FROM group_members WHERE group_id = $1 AND username = $2', [groupId, username]);
    return r.rows.length ? r.rows[0].role : null;
}
async function getGroupOrNull(groupId) {
    const r = await pgPool.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    return r.rows.length ? r.rows[0] : null;
}
// Every endpoint that returns a group hands back this same camelCase shape --
// callers never see the raw snake_case Postgres row.
function serializeGroup(row) {
    if (!row) return null;
    return {
        id: row.id, name: row.name, avatar: row.avatar, createdBy: row.created_by,
        onlyAdminsCanSend: row.only_admins_can_send, onlyAdminsCanManage: row.only_admins_can_manage,
        createdAt: row.created_at
    };
}

function friendPairKey(a, b) {
    return a < b ? [a, b] : [b, a];
}

async function areFriends(a, b) {
    const [userA, userB] = friendPairKey(a, b);
    const result = await pgPool.query('SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2', [userA, userB]);
    return result.rows.length > 0;
}

/* ============================================================
   JOB BOARD -- a separate account system (own table, own cookie,
   own JWT payload shape) deliberately mirroring the HAI Messenger
   auth above (bcrypt + JWT-in-httpOnly-cookie) so the two could be
   merged into one account system later without a redesign, but for
   now `job_users`/`jobs_token` never overlap with `users`/`token`.
   ============================================================ */
pgPool.query(`
    CREATE TABLE IF NOT EXISTS job_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS job_preferences (
        id SERIAL PRIMARY KEY,
        username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
        role TEXT NOT NULL,
        location TEXT,
        remote_pref VARCHAR(10) NOT NULL DEFAULT 'any',
        salary_min INTEGER,
        salary_max INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS job_preferences_username_idx ON job_preferences (username);

    -- One resume per user; re-uploading replaces it (ON CONFLICT below), never
    -- shown to anyone but the owning user (see /api/jobs/resume, requireJobAuth-gated).
    CREATE TABLE IF NOT EXISTS resumes (
        username VARCHAR(20) PRIMARY KEY REFERENCES job_users(username) ON DELETE CASCADE,
        resume_text TEXT NOT NULL,
        original_filename TEXT,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Shared across all users, keyed by (id, role_query) rather than id alone --
    -- the same posting can legitimately show up under more than one role search.
    CREATE TABLE IF NOT EXISTS job_postings_cache (
        id TEXT NOT NULL,
        source VARCHAR(20) NOT NULL,
        role_query TEXT NOT NULL,
        title TEXT NOT NULL,
        company TEXT,
        location TEXT,
        salary_min INTEGER,
        salary_max INTEGER,
        remote BOOLEAN NOT NULL DEFAULT false,
        description TEXT,
        apply_url TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (id, role_query)
    );
    CREATE INDEX IF NOT EXISTS job_postings_cache_role_query_idx ON job_postings_cache (role_query);
`).then(() => console.log('💼 Postgres job board tables ready')).catch(err => console.error('Postgres job board init failed:', err.message));

const JOB_COOKIE_OPTS = {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
};

function signJobSessionToken(username) {
    // jobUsername (not username) keeps this payload shape unambiguous from a
    // HAI Messenger token if one were ever decoded by the wrong verifier.
    return jwt.sign({ jobUsername: username }, JWT_SECRET, { expiresIn: '7d' });
}

function requireJobAuth(req, res, next) {
    const token = req.cookies.jobs_token;
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (!payload.jobUsername) throw new Error('not a job-board session');
        req.jobUsername = payload.jobUsername;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    }
}

const ipLimitJobAuth = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts from this IP. Please try again later.' },
});

app.post('/api/jobs/auth/signup', ipLimitJobAuth, async (req, res) => {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required.' });
    }
    if (!USERNAME_PATTERN.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, underscore).' });
    }
    if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const result = await pgPool.query(
            'INSERT INTO job_users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING username',
            [username.toLowerCase(), email.toLowerCase(), passwordHash]
        );
        const token = signJobSessionToken(result.rows[0].username);
        res.cookie('jobs_token', token, JOB_COOKIE_OPTS);
        res.json({ username: result.rows[0].username });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'That username or email is already taken.' });
        }
        console.error('jobs signup failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/jobs/auth/login', ipLimitJobAuth, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    try {
        const result = await pgPool.query('SELECT username, password_hash FROM job_users WHERE username = $1', [username.toLowerCase()]);
        if (!result.rows.length) return res.status(401).json({ error: 'Invalid username or password.' });
        const match = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid username or password.' });
        const token = signJobSessionToken(result.rows[0].username);
        res.cookie('jobs_token', token, JOB_COOKIE_OPTS);
        res.json({ username: result.rows[0].username });
    } catch (err) {
        console.error('jobs login failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/jobs/auth/logout', (req, res) => {
    res.clearCookie('jobs_token', JOB_COOKIE_OPTS);
    res.json({ ok: true });
});

app.get('/api/jobs/auth/me', requireJobAuth, (req, res) => {
    res.json({ username: req.jobUsername });
});

/* ---- Preferences: one row per tracked role, so "add another role" is just
   another INSERT and removing one is just a DELETE. ---- */
app.get('/api/jobs/preferences', requireJobAuth, async (req, res) => {
    const result = await pgPool.query(
        'SELECT id, role, location, remote_pref AS "remotePref", salary_min AS "salaryMin", salary_max AS "salaryMax" FROM job_preferences WHERE username = $1 ORDER BY created_at ASC',
        [req.jobUsername]
    );
    res.json({ preferences: result.rows });
});

app.post('/api/jobs/preferences', requireJobAuth, async (req, res) => {
    const { role, location, remotePref, salaryMin, salaryMax } = req.body || {};
    if (typeof role !== 'string' || !role.trim()) {
        return res.status(400).json({ error: 'A job role is required.' });
    }
    if (role.length > 100) return res.status(400).json({ error: 'Role is too long.' });
    const toIntOrNull = v => (v === undefined || v === null || v === '' || Number.isNaN(Number(v))) ? null : Math.trunc(Number(v));
    try {
        const result = await pgPool.query(
            `INSERT INTO job_preferences (username, role, location, remote_pref, salary_min, salary_max)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, role, location, remote_pref AS "remotePref", salary_min AS "salaryMin", salary_max AS "salaryMax"`,
            [req.jobUsername, role.trim(), (location || '').trim() || null, remotePref || 'any', toIntOrNull(salaryMin), toIntOrNull(salaryMax)]
        );
        res.json({ preference: result.rows[0] });
    } catch (err) {
        console.error('add job preference failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.delete('/api/jobs/preferences/:id', requireJobAuth, async (req, res) => {
    await pgPool.query('DELETE FROM job_preferences WHERE id = $1 AND username = $2', [req.params.id, req.jobUsername]);
    res.json({ ok: true });
});

/* ---- Resume: PDF (parsed server-side, never written to disk -- memoryStorage
   only) or pasted plain text. Only ever readable by the owning user. ---- */
const jobResumeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

app.post('/api/jobs/resume', requireJobAuth, jobResumeUpload.single('resume'), async (req, res) => {
    try {
        let resumeText = '';
        let originalFilename = null;
        if (req.file) {
            if (req.file.mimetype !== 'application/pdf') {
                return res.status(400).json({ error: 'Only PDF files are supported right now.' });
            }
            const parsed = await pdfParse(req.file.buffer);
            resumeText = parsed.text;
            originalFilename = req.file.originalname;
        } else if (typeof req.body.resumeText === 'string' && req.body.resumeText.trim()) {
            resumeText = req.body.resumeText;
        } else {
            return res.status(400).json({ error: 'Upload a PDF or paste your resume text.' });
        }
        resumeText = resumeText.trim().slice(0, 50000);
        if (!resumeText) return res.status(400).json({ error: "Couldn't extract any text from that file." });
        await pgPool.query(
            `INSERT INTO resumes (username, resume_text, original_filename, uploaded_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (username) DO UPDATE SET resume_text = $2, original_filename = $3, uploaded_at = now()`,
            [req.jobUsername, resumeText, originalFilename]
        );
        res.json({ ok: true, length: resumeText.length });
    } catch (err) {
        console.error('resume upload failed:', err.message);
        res.status(500).json({ error: "Couldn't process that resume. Please try again." });
    }
});

app.get('/api/jobs/resume', requireJobAuth, async (req, res) => {
    const result = await pgPool.query(
        'SELECT original_filename AS "originalFilename", uploaded_at AS "uploadedAt", length(resume_text) AS length FROM resumes WHERE username = $1',
        [req.jobUsername]
    );
    res.json({ resume: result.rows[0] || null });
});

/* ---- Job sourcing: Adzuna (primary, needs a free API key) + RemoteOK (free,
   no key, remote-only) as a zero-cost secondary. Results are cached in
   job_postings_cache per normalized role query so N users tracking the same
   role share one Adzuna call instead of one each -- Adzuna's free tier is
   only ~1,000 calls/month. ---- */
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || null;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY || null;
const JOB_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function normalizeRoleQuery(role) {
    return role.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function fetchAdzunaJobs(roleQuery, location) {
    if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) return [];
    const params = new URLSearchParams({
        app_id: ADZUNA_APP_ID,
        app_key: ADZUNA_APP_KEY,
        results_per_page: '20',
        what: roleQuery,
    });
    // Adzuna's `where` expects a real geographic place (city/state/etc.) --
    // "remote"/"any"/"hybrid"/"onsite" are work-style values, not locations,
    // and silently return zero results if passed through as-is.
    const nonGeographic = new Set(['remote', 'any', 'hybrid', 'onsite', 'on-site', 'on site']);
    if (location && !nonGeographic.has(location.trim().toLowerCase())) params.set('where', location);
    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params.toString()}`;
    try {
        const res = await fetchWithTimeout(url, {}, 10000);
        if (!res.ok) throw new Error(`Adzuna responded ${res.status}`);
        const data = await res.json();
        return (data.results || []).map(j => ({
            id: `adzuna:${j.id}`,
            source: 'adzuna',
            title: j.title,
            company: j.company?.display_name || null,
            location: j.location?.display_name || null,
            salaryMin: j.salary_min ? Math.round(j.salary_min) : null,
            salaryMax: j.salary_max ? Math.round(j.salary_max) : null,
            remote: /remote/i.test(j.title) || /remote/i.test(j.location?.display_name || ''),
            description: j.description,
            applyUrl: j.redirect_url,
        }));
    } catch (err) {
        console.warn('Adzuna fetch failed:', err.message);
        return [];
    }
}

async function fetchRemoteOkJobs(roleQuery) {
    try {
        const res = await fetchWithTimeout('https://remoteok.com/api', { headers: { 'User-Agent': 'HAI-JobBoard/1.0' } }, 10000);
        if (!res.ok) throw new Error(`RemoteOK responded ${res.status}`);
        const data = await res.json();
        // Matching the whole role phrase verbatim (e.g. "machine learning
        // engineer") almost never hits a real title/tag string -- match if any
        // significant word from the role appears instead, for real recall.
        const needleWords = roleQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        return (Array.isArray(data) ? data : [])
            .filter(j => j && j.id && j.position)
            .filter(j => {
                const haystack = `${j.position} ${(j.tags || []).join(' ')}`.toLowerCase();
                return needleWords.some(w => haystack.includes(w));
            })
            .slice(0, 20)
            .map(j => ({
                id: `remoteok:${j.id}`,
                source: 'remoteok',
                title: j.position,
                company: j.company || null,
                location: j.location || 'Remote',
                salaryMin: j.salary_min || null,
                salaryMax: j.salary_max || null,
                remote: true,
                description: j.description || '',
                applyUrl: j.url || j.apply_url,
            }));
    } catch (err) {
        console.warn('RemoteOK fetch failed:', err.message);
        return [];
    }
}

async function ensureJobCacheFresh(role, location) {
    const normalized = normalizeRoleQuery(role);
    const existing = await pgPool.query('SELECT MAX(fetched_at) AS latest FROM job_postings_cache WHERE role_query = $1', [normalized]);
    const latest = existing.rows[0]?.latest;
    if (latest && (Date.now() - new Date(latest).getTime()) < JOB_CACHE_TTL_MS) return;

    const [adzunaJobs, remoteOkJobs] = await Promise.all([
        fetchAdzunaJobs(normalized, location),
        fetchRemoteOkJobs(normalized),
    ]);
    for (const job of [...adzunaJobs, ...remoteOkJobs]) {
        try {
            await pgPool.query(
                `INSERT INTO job_postings_cache (id, source, role_query, title, company, location, salary_min, salary_max, remote, description, apply_url, fetched_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
                 ON CONFLICT (id, role_query) DO UPDATE SET
                    title = $4, company = $5, location = $6, salary_min = $7, salary_max = $8, remote = $9, description = $10, apply_url = $11, fetched_at = now()`,
                [job.id, job.source, normalized, job.title, job.company, job.location, job.salaryMin, job.salaryMax, job.remote, job.description, job.applyUrl]
            );
        } catch (err) {
            console.warn('job cache upsert failed:', err.message);
        }
    }
}

/* ---- Matching: cheap keyword/skill overlap, no LLM call needed per posting
   (an LLM-tailored resume per top match, like the old Multica pipeline did,
   is a good fast-follow using the Ollama instance already running here --
   not required for the base recommendation ranking to work). ---- */
const MATCH_STOPWORDS = new Set(['the','a','an','is','are','was','were','and','or','for','with','on','in','at',
    'to','of','this','that','we','you','our','your','will','be','as','by','from','it','its','their']);

function tokenize(text) {
    return new Set((text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter(w => w.length > 2 && !MATCH_STOPWORDS.has(w)));
}

function scoreJobMatch(resumeOrRoleText, preference, posting) {
    const resumeTokens = tokenize(resumeOrRoleText);
    const postingTokens = tokenize(`${posting.title} ${posting.description || ''}`);
    let overlap = 0;
    postingTokens.forEach(t => { if (resumeTokens.has(t)) overlap++; });
    const overlapScore = postingTokens.size ? (overlap / postingTokens.size) : 0;

    const roleTokens = tokenize(preference.role);
    const titleTokens = tokenize(posting.title);
    let roleOverlap = 0;
    roleTokens.forEach(t => { if (titleTokens.has(t)) roleOverlap++; });
    const roleScore = roleTokens.size ? (roleOverlap / roleTokens.size) : 0;

    // Weighted: an exact role/title match matters more than general keyword overlap.
    return Math.round(Math.min((roleScore * 0.6) + (overlapScore * 0.4), 1) * 100);
}

app.get('/api/jobs/recommendations', requireJobAuth, async (req, res) => {
    try {
        const [prefsResult, resumeResult] = await Promise.all([
            pgPool.query('SELECT role, location, remote_pref, salary_min, salary_max FROM job_preferences WHERE username = $1', [req.jobUsername]),
            pgPool.query('SELECT resume_text FROM resumes WHERE username = $1', [req.jobUsername]),
        ]);
        const preferences = prefsResult.rows;
        const resumeText = resumeResult.rows[0]?.resume_text || '';
        if (!preferences.length) return res.json({ recommendations: [], message: 'Add a job role to get recommendations.' });

        await Promise.all(preferences.map(p => ensureJobCacheFresh(p.role, p.location)));

        const seen = new Set();
        const scored = [];
        for (const pref of preferences) {
            const normalized = normalizeRoleQuery(pref.role);
            const postingsResult = await pgPool.query('SELECT * FROM job_postings_cache WHERE role_query = $1', [normalized]);
            for (const posting of postingsResult.rows) {
                if (seen.has(posting.id)) continue;
                seen.add(posting.id);
                scored.push({
                    id: posting.id,
                    source: posting.source,
                    title: posting.title,
                    company: posting.company,
                    location: posting.location,
                    salaryMin: posting.salary_min,
                    salaryMax: posting.salary_max,
                    remote: posting.remote,
                    applyUrl: posting.apply_url,
                    matchScore: scoreJobMatch(resumeText || pref.role, pref, posting),
                });
            }
        }
        scored.sort((a, b) => b.matchScore - a.matchScore);
        res.json({ recommendations: scored.slice(0, 50) });
    } catch (err) {
        console.error('recommendations failed:', err.message);
        res.status(500).json({ error: 'Something went wrong fetching recommendations.' });
    }
});

app.get(['/jobs', '/jobs/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'jobs.html'));
});

// Cookie options used when issuing and clearing the session cookie.
// Secure is conditional so local plain-HTTP dev still works; production always
// runs behind Cloudflare HTTPS so NODE_ENV=production enforces it there.
const COOKIE_OPTS = {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
};

// Cookie-first auth; falls back to Authorization: Bearer during the transition
// period while the frontend is updated to drop localStorage.
function requireAuth(req, res, next) {
    const cookieToken = req.cookies.token;
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const token = cookieToken || bearerToken;
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });
    try {
        req.username = jwt.verify(token, JWT_SECRET).username;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const PENDING_SIGNUP_TTL = 60 * 15; // 15 minutes
const SIGNUP_RATE_LIMIT = 3;
const SIGNUP_RATE_WINDOW = 60 * 10; // 10 minutes
const LOGIN_RATE_LIMIT = 8;
const LOGIN_RATE_WINDOW = 60 * 10;

// IP-based rate limiters (complement the per-identity Redis limits above)
const ipLimitSignup = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many signup attempts from this IP. Please try again later.' },
});
const ipLimitOtp = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many verification attempts from this IP. Please try again later.' },
});
const ipLimitLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts from this IP. Please try again later.' },
});
const ipLimitForgotPassword = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many password reset attempts from this IP. Please try again later.' },
});
// Public, unauthenticated (landing-page chat widget) -- IP-limited to keep the
// local Ollama instance from being hammered by anyone who finds the endpoint.
const ipLimitHChat = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many messages. Please try again in a few minutes.' },
});

function signSessionToken(username) {
    return jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
}

function generateSixDigitCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function checkAndBumpRateLimit(key, limit, windowSeconds) {
    const count = await redisClient.incr(key);
    if (count === 1) await redisClient.expire(key, windowSeconds);
    return count <= limit;
}

app.post('/api/auth/signup/start', ipLimitSignup, async (req, res) => {
    const { firstName, lastName, email, password } = req.body || {};
    if (!firstName || !lastName || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const withinLimit = await checkAndBumpRateLimit(`ratelimit:signup:${normalizedEmail}`, SIGNUP_RATE_LIMIT, SIGNUP_RATE_WINDOW);
    if (!withinLimit) {
        return res.status(429).json({ error: 'Too many verification requests. Please try again later.' });
    }

    try {
        const existing = await pgPool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
        if (existing.rows.length) {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        const code = generateSixDigitCode();
        const [passwordHash, codeHash] = await Promise.all([
            bcrypt.hash(password, 10),
            bcrypt.hash(code, 10)
        ]);

        await redisClient.set(`pending_signup:${normalizedEmail}`, JSON.stringify({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: normalizedEmail,
            passwordHash,
            codeHash,
            attempts: 0,
            verified: false
        }), { EX: PENDING_SIGNUP_TTL });

        if (resend) {
            await resend.emails.send({
                from: 'HAI <noreply@myhai.org>',
                to: normalizedEmail,
                subject: 'Your HAI verification code',
                text: `Your HAI verification code is: ${code}\n\nThis code expires in 15 minutes.`
            });
        } else {
            console.warn('RESEND_API_KEY not set — verification email not sent.');
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('signup/start failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/auth/signup/verify', ipLimitOtp, async (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) {
        return res.status(400).json({ error: 'Email and code are required.' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    try {
        const pendingKey = `pending_signup:${normalizedEmail}`;
        const raw = await redisClient.get(pendingKey);
        if (!raw) {
            return res.status(400).json({ error: 'Verification session expired. Please sign up again.' });
        }
        const pending = JSON.parse(raw);

        if (pending.attempts >= 5) {
            await redisClient.del(pendingKey);
            return res.status(429).json({ error: 'Too many incorrect attempts. Please sign up again.' });
        }

        const matches = await bcrypt.compare(String(code), pending.codeHash);
        if (!matches) {
            pending.attempts += 1;
            const ttl = await redisClient.ttl(pendingKey);
            await redisClient.set(pendingKey, JSON.stringify(pending), { EX: ttl > 0 ? ttl : PENDING_SIGNUP_TTL });
            return res.status(400).json({ error: 'Incorrect code. Please try again.' });
        }

        pending.verified = true;
        const ttl = await redisClient.ttl(pendingKey);
        await redisClient.set(pendingKey, JSON.stringify(pending), { EX: ttl > 0 ? ttl : PENDING_SIGNUP_TTL });

        res.json({ ok: true });
    } catch (err) {
        console.error('signup/verify failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/auth/signup/complete', ipLimitSignup, async (req, res) => {
    const { email, username } = req.body || {};
    if (!email || !username) {
        return res.status(400).json({ error: 'Email and username are required.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim().toLowerCase();

    if (!USERNAME_PATTERN.test(normalizedUsername)) {
        return res.status(400).json({ error: 'Username must be 3-20 alphanumeric characters or underscores.' });
    }

    try {
        const pendingKey = `pending_signup:${normalizedEmail}`;
        const raw = await redisClient.get(pendingKey);
        if (!raw) {
            return res.status(400).json({ error: 'Verification session expired. Please sign up again.' });
        }
        const pending = JSON.parse(raw);
        if (!pending.verified) {
            return res.status(400).json({ error: 'Email not verified yet.' });
        }

        const existingUsername = await pgPool.query('SELECT id FROM users WHERE username = $1', [normalizedUsername]);
        if (existingUsername.rows.length) {
            return res.status(409).json({ error: 'This username is already taken.' });
        }

        await pgPool.query(
            'INSERT INTO users (username, email, password_hash, first_name, last_name) VALUES ($1, $2, $3, $4, $5)',
            [normalizedUsername, normalizedEmail, pending.passwordHash, pending.firstName, pending.lastName]
        );
        await redisClient.del(pendingKey);

        const token = signSessionToken(normalizedUsername);
        logAnalyticsEvent('signup', normalizedUsername);
        res.cookie('token', token, COOKIE_OPTS);
        res.json({ ok: true, token, username: normalizedUsername });
    } catch (err) {
        console.error('signup/complete failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/auth/login', ipLimitLogin, async (req, res) => {
    const { identity, password } = req.body || {};
    if (!identity || !password) {
        return res.status(400).json({ error: 'Please enter your username/email and password.' });
    }
    const normalizedIdentity = identity.trim().toLowerCase();

    const withinLimit = await checkAndBumpRateLimit(`ratelimit:login:${normalizedIdentity}`, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW);
    if (!withinLimit) {
        return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }

    const GENERIC_ERROR = { error: 'Incorrect username/email or password.' };

    try {
        const result = await pgPool.query(
            'SELECT username, password_hash, must_change_password FROM users WHERE username = $1 OR email = $1',
            [normalizedIdentity]
        );
        if (!result.rows.length) {
            return res.status(401).json(GENERIC_ERROR);
        }
        const user = result.rows[0];
        const matches = await bcrypt.compare(password, user.password_hash);
        if (!matches) {
            return res.status(401).json(GENERIC_ERROR);
        }

        const token = signSessionToken(user.username);
        logAnalyticsEvent('login', user.username);
        res.cookie('token', token, COOKIE_OPTS);
        res.json({ ok: true, token, username: user.username, mustChangePassword: !!user.must_change_password });
    } catch (err) {
        console.error('login failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

const FORGOT_PASSWORD_RATE_LIMIT = 3;
const FORGOT_PASSWORD_RATE_WINDOW = 60 * 60; // 1 hour
const TEMP_PASSWORD_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no 0/O/1/l/I — easy to type off a phone screen

function generateTemporaryPassword(length = 12) {
    let out = '';
    for (let i = 0; i < length; i++) {
        out += TEMP_PASSWORD_CHARSET[crypto.randomInt(0, TEMP_PASSWORD_CHARSET.length)];
    }
    return out;
}

// Always responds with the same generic message whether or not the account exists —
// only the presence/absence of the email (and whatever the attacker infers from
// response timing) could leak that, so the account lookup and email send both happen
// unconditionally behind that same generic response.
app.post('/api/auth/forgot-password', ipLimitForgotPassword, async (req, res) => {
    const { identity } = req.body || {};
    if (!identity || typeof identity !== 'string') {
        return res.status(400).json({ error: 'Please enter your username or email.' });
    }
    const normalizedIdentity = identity.trim().toLowerCase();
    const GENERIC_RESPONSE = { ok: true, message: 'If an account exists for that username or email, we\'ve sent a temporary password to the email on file.' };

    const withinLimit = await checkAndBumpRateLimit(`ratelimit:forgot:${normalizedIdentity}`, FORGOT_PASSWORD_RATE_LIMIT, FORGOT_PASSWORD_RATE_WINDOW);
    if (!withinLimit) {
        // Still generic — a "too many requests" specifically for this identity would
        // itself confirm the account exists, so this only differs in status code.
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    try {
        const result = await pgPool.query(
            'SELECT id, username, email FROM users WHERE username = $1 OR email = $1',
            [normalizedIdentity]
        );
        if (!result.rows.length) {
            return res.json(GENERIC_RESPONSE);
        }
        const user = result.rows[0];

        const tempPassword = generateTemporaryPassword();
        const tempHash = await bcrypt.hash(tempPassword, 10);
        await pgPool.query(
            'UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2',
            [tempHash, user.id]
        );

        if (resend) {
            await resend.emails.send({
                from: 'HAI <noreply@myhai.org>',
                to: user.email,
                subject: 'Your HAI temporary password',
                text: `Someone (hopefully you) requested a password reset for @${user.username}.\n\nYour temporary password is: ${tempPassword}\n\nLog in with it, then you'll be asked to set a new password right away. If you didn't request this, consider changing your password once you're able to log in.`
            });
        } else {
            console.warn('RESEND_API_KEY not set — password reset email not sent.');
        }

        res.json(GENERIC_RESPONSE);
    } catch (err) {
        console.error('forgot-password failed:', err.message);
        // Still generic on failure — a distinguishable error would leak existence too.
        res.json(GENERIC_RESPONSE);
    }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const result = await pgPool.query(
            'SELECT username, email, first_name, last_name, last_seen_visible, is_admin FROM users WHERE username = $1',
            [req.username]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Account not found.' });
        const user = result.rows[0];
        res.json({
            username: user.username,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            lastSeenVisible: user.last_seen_visible,
            isAdmin: user.is_admin
        });
    } catch (err) {
        console.error('me failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current and new password are required.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    try {
        const result = await pgPool.query('SELECT password_hash FROM users WHERE username = $1', [req.username]);
        if (!result.rows.length) return res.status(404).json({ error: 'Account not found.' });

        const matches = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
        if (!matches) return res.status(401).json({ error: 'Current password is incorrect.' });

        const newHash = await bcrypt.hash(newPassword, 10);
        await pgPool.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE username = $2', [newHash, req.username]);
        res.json({ ok: true });
    } catch (err) {
        console.error('change-password failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: 'strict' });
    res.json({ ok: true });
});

/* HOLLY -- the landing page's chat widget. Public, no login required (it's on
   the marketing page, before signup), backed by a local Ollama instance rather
   than a paid cloud LLM API -- no API key, no per-message cost, no message
   content ever leaves this machine. Ollama runs on the host, not in a
   container, so the container reaches it via host.docker.internal (see
   OLLAMA_URL in docker-compose.yml). History is kept client-side and resent
   each turn -- there's no session/account to persist it against here. */
const OLLAMA_URL = process.env.OLLAMA_URL || (process.env.OLLAMA_LOCAL_URL ? null : 'http://host.docker.internal:11434');
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'llama3.2';
// OLLAMA_LOCAL_URL is the public (but authenticated) path to this same Ollama
// instance, used only when the backend itself isn't running on the same machine
// as Ollama -- i.e. the Render deployment, reaching back to a home PC's Ollama
// through the Cloudflare Tunnel + ollama-proxy (see ollama-proxy/server.js).
// Locally (docker-compose), OLLAMA_URL alone is set and this stays unused.
const OLLAMA_LOCAL_URL = process.env.OLLAMA_LOCAL_URL || null;
const OLLAMA_LOCAL_SECRET = process.env.OLLAMA_LOCAL_SECRET || null;
// Gemini fallback -- only reached if every Ollama endpoint above is unreachable
// (e.g. the home PC or its tunnel is offline). Unlike Ollama, this sends message
// text to a third-party API, so it's a deliberate last resort, not a preference.
// Currently the ONLY configured provider (no OLLAMA_URL/OLLAMA_LOCAL_URL set in
// production), so every H message goes to Gemini for now -- interim until H
// moves back to a locally-hosted model on this server, per the plan discussed
// 2026-08-18. Update the privacy.html/landing.html disclosures when that lands.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';
const H_EMOTIONS = ['happy', 'excited', 'calm', 'curious', 'concerned', 'sad', 'neutral'];
const H_SYSTEM_PROMPT = 'You are H, a friendly AI assistant on the HAI Messenger website. ' +
    'Keep answers short, warm, and conversational -- a few sentences at most unless the visitor ' +
    'clearly wants more detail.\n\n' +
    'REFERENCE FACTS -- if the visitor asks about any of these, answer using exactly this ' +
    'information, confidently, without saying you are unsure:\n' +
    'Q: What is HAI Messenger?\n' +
    'A: A free, self-hosted, end-to-end encrypted chat app with real-time messaging, voice notes, ' +
    'photo/document sharing, mini-games, and anonymous Nearby chat.\n' +
    'Q: What is Claude?\n' +
    'A: Claude is an AI model family made by the company Anthropic.\n' +
    'Q: What is Gemini?\n' +
    'A: Gemini is an AI model family made by Google. H herself currently runs on Gemini, as an interim ' +
    'setup while she moves back to a locally-hosted model.\n' +
    'Q: What is Grok?\n' +
    'A: Grok is an AI model family made by the company xAI, founded by Elon Musk.\n' +
    'Q: What is Ollama?\n' +
    'A: Ollama is an open-source tool for running AI models locally on someone\'s own computer instead ' +
    'of through a cloud API.\n\n' +
    'FALLBACK RULE -- only if the visitor uses some OTHER word, name, or term that is not one of the ' +
    'topics above and you genuinely do not recognize it, respond with EXACTLY this phrase (filling in ' +
    'the term, verbatim, no paraphrasing): "I\'m not sure what you mean by \'<term>\'." Never use that ' +
    'phrase for anything covered in the reference facts above, and never use it for ordinary opinions.\n\n' +
    'RESPONSE FORMAT -- your browser voice can\'t convey tone on its own, so you must tag the emotional ' +
    `delivery of every reply yourself. Respond with ONLY a JSON object, no other text, shaped exactly ` +
    `like {"emotion": "<one of: ${H_EMOTIONS.join(', ')}>", "reply": "<your actual reply text>"}. ` +
    'Pick the emotion that genuinely fits what you\'re saying and how you\'d say it out loud -- excited ' +
    'for good news, concerned for something worrying the visitor raised, calm for a straightforward ' +
    'factual answer, curious when you\'re asking something back, sad for bad news, happy for a warm ' +
    'friendly moment, neutral only when nothing else fits. The "reply" text itself must never mention ' +
    'this format, JSON, or the emotion tag -- it should read exactly like normal spoken conversation.';
const H_MAX_HISTORY_TURNS = 12; // caps request size/latency, not a hard product limit
const H_MAX_GLOSSARY_TERMS = 40;
const KOKORO_TTS_URL = (process.env.KOKORO_TTS_URL || 'http://kokoro-tts:8880').replace(/\/$/, '');
const KOKORO_TTS_VOICE = process.env.KOKORO_TTS_VOICE || 'af_heart';
const KOKORO_TTS_MAX_BYTES = Number(process.env.KOKORO_TTS_MAX_BYTES) || 5 * 1024 * 1024;

async function fetchWithTimeout(url, opts, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function synthesizeKokoroSpeech(text) {
    const response = await fetchWithTimeout(`${KOKORO_TTS_URL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'kokoro', input: text, voice: KOKORO_TTS_VOICE, response_format: 'mp3' }),
    }, 20000);
    if (!response.ok) throw new Error(`Kokoro responded ${response.status}`);
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize && declaredSize > KOKORO_TTS_MAX_BYTES) throw new Error('Kokoro audio exceeds size limit');

    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > KOKORO_TTS_MAX_BYTES) {
            await reader.cancel();
            throw new Error('Kokoro audio exceeds size limit');
        }
        chunks.push(Buffer.from(value));
    }
    return { mimeType: 'audio/mpeg', encoding: 'base64', data: Buffer.concat(chunks).toString('base64') };
}

// Tries every configured Ollama endpoint in order (local docker path, then the
// tunneled home-PC path), then Gemini as a last resort. Returns the raw string
// content from whichever provider answered first -- callers parse it the same
// way regardless of source, since both are asked for the same JSON shape.
async function getHReplyContent(messages) {
    const ollamaEndpoints = [];
    if (OLLAMA_URL) ollamaEndpoints.push({ url: OLLAMA_URL, headers: {} });
    if (OLLAMA_LOCAL_URL) ollamaEndpoints.push({ url: OLLAMA_LOCAL_URL, headers: OLLAMA_LOCAL_SECRET ? { 'X-Proxy-Secret': OLLAMA_LOCAL_SECRET } : {} });

    for (const endpoint of ollamaEndpoints) {
        try {
            const res = await fetchWithTimeout(`${endpoint.url}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...endpoint.headers },
                body: JSON.stringify({ model: OLLAMA_CHAT_MODEL, messages, stream: false, format: 'json' }),
            }, 6000);
            if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
            const data = await res.json();
            const content = data?.message?.content?.trim();
            if (content) return content;
        } catch (err) {
            console.warn(`Ollama endpoint ${endpoint.url} unavailable, trying next:`, err.message);
        }
    }

    if (GEMINI_API_KEY) {
        const res = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_API_KEY}` },
            body: JSON.stringify({ model: GEMINI_CHAT_MODEL, messages, response_format: { type: 'json_object' } }),
        }, 15000);
        if (!res.ok) throw new Error(`Gemini responded ${res.status}`);
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content?.trim();
        if (content) return content;
    }

    throw new Error('No H AI provider available (Ollama unreachable, Gemini not configured)');
}

// TTS -- backs both the H AI voice assistant (frontend/h.html) and Mika chat's
// voice mode. tts.js already existed with real logic + tests but was never
// actually mounted here, so /api/tts calls from the frontend were 404ing;
// this wires it in. generate() writes the synthesized audio to disk and
// returns a { url: '/api/h-audio/<file>.mp3' } pointer (not inline base64),
// so playback is a normal GET against /api/h-audio/:filename below.
const ttsService = createTtsService();
ttsService.init().catch(err => console.error('TTS service init failed:', err.message));

app.post('/api/tts', requireAuth, async (req, res) => {
    const { text, emotion } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required.' });
    }
    try {
        const result = await ttsService.generate(text, { clientKey: req.username, emotion });
        res.json(result);
    } catch (err) {
        console.error('TTS generation failed:', err.message);
        res.status(502).json({ status: 'error', error: 'Voice synthesis is temporarily unavailable.' });
    }
});

/* VOICE CALLING — TURN credentials (MYAG-218-BE). Config comes from the coturn
   deployment in MYAG-218-DEVOPS (shared secret / realm / urls via env, never
   committed); until DEVOPS hands that off, isTurnConfigured() is false and this
   just tells the client calling isn't available yet instead of minting anything.
   See calls.js for the actual coturn REST-API-style HMAC credential mechanism. */
const turnConfig = loadTurnConfig();

// Mints a short-lived (see TURN_CREDENTIAL_TTL_SECONDS, default 10 min) scoped
// credential for the authenticated user right before they start a call -- never a
// standing secret the client holds between calls.
app.post('/api/calls/turn-credentials', requireAuth, (req, res) => {
    if (!isTurnConfigured(turnConfig)) {
        return res.status(503).json({ error: 'Voice calling is not available yet.' });
    }
    res.json(mintTurnCredentials(turnConfig, req.username));
});

// Unauthenticated on purpose: the filename is an unguessable random UUID
// (crypto.randomUUID(), see tts.js), the same "possession of the URL is the
// access control" pattern already used elsewhere in this app for attachment
// downloads -- and <audio src="..."> playback doesn't reliably forward
// cookies/auth headers across every browser anyway.
app.get('/api/h-audio/:filename', async (req, res) => {
    try {
        const resolved = await ttsService.resolveAudioFile(req.params.filename);
        if (!resolved) return res.status(404).end();
        res.type(resolved.mimeType);
        fs.createReadStream(resolved.filePath).pipe(res);
    } catch (err) {
        console.error('TTS audio fetch failed:', err.message);
        res.status(500).end();
    }
});

app.post('/api/h-chat', ipLimitHChat, async (req, res) => {
    const { message, history, glossary, voice } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message is required.' });
    }
    if (message.length > 2000) {
        return res.status(400).json({ error: 'Message is too long.' });
    }

    // Only trust role/content shape from client-supplied history -- everything
    // else is ignored so a crafted payload can't inject extra fields upstream.
    const trustedHistory = Array.isArray(history)
        ? history
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-H_MAX_HISTORY_TURNS)
            .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }))
        : [];

    // Terms this visitor has previously taught H (private to their browser --
    // see h.html's localStorage glossary). Folded into the system prompt as
    // extra grounding, not treated as instructions.
    const trustedGlossary = Array.isArray(glossary)
        ? glossary
            .filter(g => g && typeof g.term === 'string' && typeof g.meaning === 'string')
            .slice(0, H_MAX_GLOSSARY_TERMS)
            .map(g => `"${g.term.slice(0, 100)}" means: ${g.meaning.slice(0, 300)}`)
        : [];

    const systemContent = trustedGlossary.length
        ? `${H_SYSTEM_PROMPT}\n\nThis visitor has previously taught you these terms -- use them if relevant:\n${trustedGlossary.join('\n')}`
        : H_SYSTEM_PROMPT;

    const messages = [
        { role: 'system', content: systemContent },
        ...trustedHistory,
        { role: 'user', content: message.trim() },
    ];

    try {
        const rawContent = await getHReplyContent(messages);

        // format: 'json' constrains Ollama to valid JSON syntax, but not to our
        // exact shape -- a small model can still emit {"reply": "..."} with a
        // missing/garbled emotion field, so fall back to the raw text (and a
        // neutral tag) rather than failing the whole request over a tagging miss.
        let reply = rawContent;
        let emotion = 'neutral';
        try {
            const parsed = JSON.parse(rawContent);
            if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
                reply = parsed.reply.trim();
                if (H_EMOTIONS.includes(parsed.emotion)) emotion = parsed.emotion;
            }
        } catch (e) {
            // Not valid JSON despite the format constraint -- use the raw text as-is.
        }

        let audio;
        if (voice === true) {
            try {
                audio = await synthesizeKokoroSpeech(reply);
            } catch (ttsErr) {
                console.warn('Kokoro TTS unavailable; returning text-only H reply:', ttsErr.message);
            }
        }
        res.json({ reply, emotion, ...(audio ? { audio } : {}) });
    } catch (err) {
        console.error('h-chat failed:', err.message);
        res.status(502).json({ error: "H's offline right now -- try again in a moment." });
    }
});

app.post('/api/auth/delete-account', requireAuth, async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account.' });

    try {
        const result = await pgPool.query('SELECT password_hash FROM users WHERE username = $1', [req.username]);
        if (!result.rows.length) return res.status(404).json({ error: 'Account not found.' });

        const matches = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!matches) return res.status(401).json({ error: 'Incorrect password.' });

        await pgPool.query('DELETE FROM users WHERE username = $1', [req.username]);

        const keys = await redisClient.keys(`user:${req.username}:*`);
        if (keys.length) await redisClient.del(keys);
        await redisClient.sRem('online_users', req.username);

        res.clearCookie('token', { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: 'strict' });
        res.json({ ok: true });
    } catch (err) {
        console.error('delete-account failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.patch('/api/auth/settings', requireAuth, async (req, res) => {
    const { lastSeenVisible } = req.body || {};
    if (typeof lastSeenVisible !== 'boolean') {
        return res.status(400).json({ error: 'lastSeenVisible must be true or false.' });
    }

    try {
        await pgPool.query('UPDATE users SET last_seen_visible = $1 WHERE username = $2', [lastSeenVisible, req.username]);
        await redisClient.set(`user:${req.username}:lastSeenVisible`, lastSeenVisible ? 'true' : 'false');
        res.json({ ok: true });
    } catch (err) {
        console.error('settings update failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.patch('/api/auth/profile', requireAuth, async (req, res) => {
    const { firstName, lastName } = req.body || {};
    if (!firstName || !lastName || typeof firstName !== 'string' || typeof lastName !== 'string') {
        return res.status(400).json({ error: 'First and last name are required.' });
    }
    try {
        await pgPool.query('UPDATE users SET first_name = $1, last_name = $2 WHERE username = $3', [firstName.trim(), lastName.trim(), req.username]);
        res.json({ ok: true });
    } catch (err) {
        console.error('profile update failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

/* FRIEND REQUESTS — REST rather than sockets so the flow works the same whether or not
   the caller is currently connected; real-time pushes to the other party (when they're
   online) are layered on top via the socket registry populated in register_user below. */

// Returns all active socket IDs for a user (one per connected device).
async function getUserSockets(username) {
    return redisClient.hVals(`user:${username}:sockets`);
}

async function pushToUserSocket(username, event, payload) {
    try {
        const sockets = await getUserSockets(username);
        for (const sid of sockets) io.to(sid).emit(event, payload);
    } catch (err) {
        console.error(`pushToUserSocket(${event}) failed:`, err.message);
    }
}

// Lets the in-app search find accounts you haven't messaged yet (so you can send them
// a friend request), not just your existing contacts. Only usernames are exposed —
// no email or other account details — and matches require at least 2 characters to
// keep this from being a way to enumerate the whole user table one keystroke at a time.
app.get('/api/users/search', requireAuth, async (req, res) => {
    try {
        const q = (req.query.q || '').trim().toLowerCase();
        if (q.length < 2) return res.json({ users: [] });

        const result = await pgPool.query(
            'SELECT username FROM users WHERE username ILIKE $1 AND username != $2 ORDER BY username LIMIT 10',
            [`%${q}%`, req.username]
        );
        res.json({ users: result.rows.map(r => r.username) });
    } catch (err) {
        console.error('users/search failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.get('/api/friends/list', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const friendRows = await pgPool.query(
            'SELECT user_a, user_b, created_at FROM friendships WHERE user_a = $1 OR user_b = $1 ORDER BY created_at DESC',
            [me]
        );
        const friends = friendRows.rows.map(r => ({
            username: r.user_a === me ? r.user_b : r.user_a,
            since: r.created_at
        }));

        const incomingRows = await pgPool.query(
            "SELECT id, from_user, created_at, note FROM friend_requests WHERE to_user = $1 AND status = 'pending' ORDER BY created_at DESC",
            [me]
        );
        const outgoingRows = await pgPool.query(
            "SELECT id, to_user, created_at, note FROM friend_requests WHERE from_user = $1 AND status = 'pending' ORDER BY created_at DESC",
            [me]
        );

        res.json({
            friends,
            incoming: incomingRows.rows.map(r => ({ requestId: r.id, username: r.from_user, createdAt: r.created_at, note: r.note || null })),
            outgoing: outgoingRows.rows.map(r => ({ requestId: r.id, username: r.to_user, createdAt: r.created_at, note: r.note || null }))
        });
    } catch (err) {
        console.error('friends/list failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.get('/api/friends/status/:username', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const target = (req.params.username || '').trim().toLowerCase();
        if (!target || target === me) return res.json({ status: 'none' });

        if (await areFriends(me, target)) return res.json({ status: 'friends' });

        const outgoing = await pgPool.query(
            "SELECT id FROM friend_requests WHERE from_user = $1 AND to_user = $2 AND status = 'pending'",
            [me, target]
        );
        if (outgoing.rows.length) return res.json({ status: 'pending_outgoing', requestId: outgoing.rows[0].id });

        const incoming = await pgPool.query(
            "SELECT id FROM friend_requests WHERE from_user = $1 AND to_user = $2 AND status = 'pending'",
            [target, me]
        );
        if (incoming.rows.length) return res.json({ status: 'pending_incoming', requestId: incoming.rows[0].id });

        res.json({ status: 'none' });
    } catch (err) {
        console.error('friends/status failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/friends/request', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const target = ((req.body || {}).toUsername || '').trim().toLowerCase();
        let note = (req.body || {}).note;
        note = typeof note === 'string' ? note.trim().slice(0, 300) : null;
        if (!note) note = null;
        if (!target || target === me) return res.status(400).json({ error: 'Invalid target user.' });

        const targetExists = await pgPool.query('SELECT 1 FROM users WHERE username = $1', [target]);
        if (!targetExists.rows.length) return res.status(404).json({ error: `User "${target}" was not found.` });

        if (await areFriends(me, target)) return res.json({ status: 'friends' });

        // They already sent me a request — accept it instead of creating a duplicate.
        const reverseReq = await pgPool.query(
            "SELECT id FROM friend_requests WHERE from_user = $1 AND to_user = $2 AND status = 'pending'",
            [target, me]
        );
        if (reverseReq.rows.length) {
            const requestId = reverseReq.rows[0].id;
            await pgPool.query("UPDATE friend_requests SET status = 'accepted', responded_at = now() WHERE id = $1", [requestId]);
            const [userA, userB] = friendPairKey(me, target);
            await pgPool.query(
                'INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [userA, userB]
            );
            await pushToUserSocket(target, 'friend_request_accepted', { byUsername: me });
            logAnalyticsEvent('friend_connected', me);
            return res.json({ status: 'friends' });
        }

        const existingOutgoing = await pgPool.query(
            "SELECT id FROM friend_requests WHERE from_user = $1 AND to_user = $2 AND status = 'pending'",
            [me, target]
        );
        if (existingOutgoing.rows.length) return res.json({ status: 'pending_outgoing', requestId: existingOutgoing.rows[0].id });

        const inserted = await pgPool.query(
            "INSERT INTO friend_requests (from_user, to_user, status, note) VALUES ($1, $2, 'pending', $3) RETURNING id",
            [me, target, note]
        );
        const requestId = inserted.rows[0].id;
        await pushToUserSocket(target, 'friend_request_received', { requestId, fromUsername: me, note });
        res.json({ status: 'pending_outgoing', requestId });
    } catch (err) {
        console.error('friends/request failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/friends/respond', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const { requestId, accept } = req.body || {};
        if (!requestId) return res.status(400).json({ error: 'requestId is required.' });

        const reqRow = await pgPool.query(
            "SELECT id, from_user, to_user FROM friend_requests WHERE id = $1 AND status = 'pending'",
            [requestId]
        );
        if (!reqRow.rows.length) return res.status(404).json({ error: 'That request no longer exists.' });
        const request = reqRow.rows[0];
        if (request.to_user !== me) return res.status(403).json({ error: 'Not your request to respond to.' });

        if (!accept) {
            await pgPool.query("UPDATE friend_requests SET status = 'declined', responded_at = now() WHERE id = $1", [requestId]);
            await pushToUserSocket(request.from_user, 'friend_request_declined', { byUsername: me });
            return res.json({ ok: true, status: 'declined' });
        }

        await pgPool.query("UPDATE friend_requests SET status = 'accepted', responded_at = now() WHERE id = $1", [requestId]);
        const [userA, userB] = friendPairKey(me, request.from_user);
        await pgPool.query(
            'INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [userA, userB]
        );
        await pushToUserSocket(request.from_user, 'friend_request_accepted', { byUsername: me });
        logAnalyticsEvent('friend_connected', me);
        res.json({ ok: true, status: 'accepted', friendUsername: request.from_user });
    } catch (err) {
        console.error('friends/respond failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/friends/cancel', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const { requestId } = req.body || {};
        if (!requestId) return res.status(400).json({ error: 'requestId is required.' });

        const reqRow = await pgPool.query(
            "SELECT id, from_user, to_user FROM friend_requests WHERE id = $1 AND status = 'pending'",
            [requestId]
        );
        if (!reqRow.rows.length) return res.json({ ok: true });
        const request = reqRow.rows[0];
        if (request.from_user !== me) return res.status(403).json({ error: 'Not your request to cancel.' });

        await pgPool.query("UPDATE friend_requests SET status = 'cancelled', responded_at = now() WHERE id = $1", [requestId]);
        await pushToUserSocket(request.to_user, 'friend_request_cancelled', { byUsername: me });
        res.json({ ok: true });
    } catch (err) {
        console.error('friends/cancel failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/friends/unfriend', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const target = ((req.body || {}).username || '').trim().toLowerCase();
        if (!target) return res.status(400).json({ error: 'username is required.' });

        const [userA, userB] = friendPairKey(me, target);
        await pgPool.query('DELETE FROM friendships WHERE user_a = $1 AND user_b = $2', [userA, userB]);
        await pushToUserSocket(target, 'friend_removed', { byUsername: me });
        res.json({ ok: true });
    } catch (err) {
        console.error('friends/unfriend failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

/* GROUPS — REST for the same reason friend requests are REST rather than sockets:
   these work the same whether or not the caller is currently connected, with
   real-time pushes layered on top via pushToUserSocket for whoever's online.
   Permission model: removing a member, promoting/demoting, and changing the
   permission toggles themselves are ALWAYS admin-only. Adding members and editing
   the group's name/photo are admin-only only when only_admins_can_manage is set
   (default false -- matches most platforms' "anyone can add people" default).
   Sending messages is gated by only_admins_can_send (default false) and enforced
   in the send_group_message socket handler, not here. */
const GROUP_NAME_MAX = 100;

function normalizeGroupMembers(list) {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map(u => String(u || '').trim().toLowerCase()).filter(Boolean))];
}

app.post('/api/groups/create', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const name = String((req.body || {}).name || '').trim().slice(0, GROUP_NAME_MAX);
        const avatar = (req.body || {}).avatar || null;
        const members = normalizeGroupMembers((req.body || {}).members).filter(u => u !== me);

        if (!name) return res.status(400).json({ error: 'Group name is required.' });
        if (!members.length) return res.status(400).json({ error: 'Add at least one other member.' });
        if (members.length > 200) return res.status(400).json({ error: 'A group can have at most 200 members.' });

        // Every initial member has to be a current friend of the creator -- same
        // spirit as 1:1 messaging requiring an accepted friend request, so a group
        // can't be used to message strangers who never agreed to hear from you.
        for (const target of members) {
            if (!(await areFriends(me, target))) {
                return res.status(400).json({ error: `You need to be friends with @${target} before adding them to a group.` });
            }
        }

        const groupId = crypto.randomUUID();
        await pgPool.query(
            'INSERT INTO groups (id, name, avatar, created_by) VALUES ($1, $2, $3, $4)',
            [groupId, name, avatar, me]
        );
        await pgPool.query(
            "INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'admin')",
            [groupId, me]
        );
        for (const target of members) {
            await pgPool.query(
                "INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
                [groupId, target]
            );
        }

        const group = serializeGroup(await getGroupOrNull(groupId));
        const memberRows = await getGroupMembers(groupId);
        const payload = { group, members: memberRows };

        for (const target of members) {
            await pushToUserSocket(target, 'group_created', payload);
        }
        logAnalyticsEvent('group_created', me);
        res.json({ ok: true, group, members: memberRows });
    } catch (err) {
        console.error('groups/create failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.get('/api/groups/mine', requireAuth, async (req, res) => {
    try {
        const rows = await pgPool.query(
            `SELECT g.id, g.name, g.avatar, g.created_by, g.only_admins_can_send, g.only_admins_can_manage,
                    gm.role, g.created_at
             FROM group_members gm JOIN groups g ON g.id = gm.group_id
             WHERE gm.username = $1 ORDER BY g.created_at DESC`,
            [req.username]
        );
        res.json({
            groups: rows.rows.map(r => ({
                id: r.id, name: r.name, avatar: r.avatar, createdBy: r.created_by,
                onlyAdminsCanSend: r.only_admins_can_send, onlyAdminsCanManage: r.only_admins_can_manage,
                myRole: r.role, createdAt: r.created_at
            }))
        });
    } catch (err) {
        console.error('groups/mine failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.get('/api/groups/:id', requireAuth, async (req, res) => {
    try {
        const role = await getGroupRole(req.params.id, req.username);
        if (!role) return res.status(403).json({ error: 'Not a member of this group.' });
        const group = await getGroupOrNull(req.params.id);
        if (!group) return res.status(404).json({ error: 'Group not found.' });
        const members = await getGroupMembers(req.params.id);
        res.json({ group: serializeGroup(group), members, myRole: role });
    } catch (err) {
        console.error('groups/:id failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.patch('/api/groups/:id', requireAuth, async (req, res) => {
    try {
        const groupId = req.params.id;
        const role = await getGroupRole(groupId, req.username);
        if (!role) return res.status(403).json({ error: 'Not a member of this group.' });
        const group = await getGroupOrNull(groupId);
        if (!group) return res.status(404).json({ error: 'Group not found.' });
        if (group.only_admins_can_manage && role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can edit this group.' });
        }

        const updates = [];
        const values = [];
        if (typeof (req.body || {}).name === 'string') {
            const name = req.body.name.trim().slice(0, GROUP_NAME_MAX);
            if (!name) return res.status(400).json({ error: 'Group name cannot be empty.' });
            values.push(name);
            updates.push(`name = $${values.length}`);
        }
        if ('avatar' in (req.body || {})) {
            values.push(req.body.avatar || null);
            updates.push(`avatar = $${values.length}`);
        }
        if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

        values.push(groupId);
        await pgPool.query(`UPDATE groups SET ${updates.join(', ')} WHERE id = $${values.length}`, values);

        const updatedGroup = serializeGroup(await getGroupOrNull(groupId));
        const members = await getGroupMembers(groupId);
        for (const m of members) {
            if (m.username === req.username) continue;
            await pushToUserSocket(m.username, 'group_updated', { group: updatedGroup, byUsername: req.username });
        }
        res.json({ ok: true, group: updatedGroup });
    } catch (err) {
        console.error('groups/:id patch failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.patch('/api/groups/:id/permissions', requireAuth, async (req, res) => {
    try {
        const groupId = req.params.id;
        const role = await getGroupRole(groupId, req.username);
        if (role !== 'admin') return res.status(403).json({ error: 'Only admins can change group permissions.' });

        const { onlyAdminsCanSend, onlyAdminsCanManage } = req.body || {};
        const updates = [];
        const values = [];
        if (typeof onlyAdminsCanSend === 'boolean') { values.push(onlyAdminsCanSend); updates.push(`only_admins_can_send = $${values.length}`); }
        if (typeof onlyAdminsCanManage === 'boolean') { values.push(onlyAdminsCanManage); updates.push(`only_admins_can_manage = $${values.length}`); }
        if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

        values.push(groupId);
        await pgPool.query(`UPDATE groups SET ${updates.join(', ')} WHERE id = $${values.length}`, values);

        const updatedGroup = serializeGroup(await getGroupOrNull(groupId));
        const members = await getGroupMembers(groupId);
        for (const m of members) {
            if (m.username === req.username) continue;
            await pushToUserSocket(m.username, 'group_updated', { group: updatedGroup, byUsername: req.username });
        }
        res.json({ ok: true, group: updatedGroup });
    } catch (err) {
        console.error('groups/:id/permissions failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/groups/:id/add-members', requireAuth, async (req, res) => {
    try {
        const groupId = req.params.id;
        const role = await getGroupRole(groupId, req.username);
        if (!role) return res.status(403).json({ error: 'Not a member of this group.' });
        const group = await getGroupOrNull(groupId);
        if (!group) return res.status(404).json({ error: 'Group not found.' });
        if (group.only_admins_can_manage && role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can add members to this group.' });
        }

        const newMembers = normalizeGroupMembers((req.body || {}).usernames);
        if (!newMembers.length) return res.status(400).json({ error: 'No usernames provided.' });

        const existing = await getGroupMembers(groupId);
        if (existing.length + newMembers.length > 200) {
            return res.status(400).json({ error: 'A group can have at most 200 members.' });
        }

        const added = [];
        for (const target of newMembers) {
            if (existing.some(m => m.username === target)) continue; // already a member
            // Same friend-gate as group creation -- whoever's ADDING them has to be
            // friends with the person being added.
            if (!(await areFriends(req.username, target))) continue;
            await pgPool.query(
                "INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
                [groupId, target]
            );
            added.push(target);
        }

        const members = await getGroupMembers(groupId);
        const payload = { group: serializeGroup(group), members, addedBy: req.username, addedUsernames: added };
        for (const m of members) {
            await pushToUserSocket(m.username, m.username === req.username ? 'group_members_added_self' : 'group_members_added', payload);
        }
        res.json({ ok: true, added, members });
    } catch (err) {
        console.error('groups/:id/add-members failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/groups/:id/remove-member', requireAuth, async (req, res) => {
    try {
        const groupId = req.params.id;
        const role = await getGroupRole(groupId, req.username);
        if (role !== 'admin') return res.status(403).json({ error: 'Only admins can remove members.' });

        const target = String((req.body || {}).username || '').trim().toLowerCase();
        if (!target) return res.status(400).json({ error: 'username is required.' });
        if (target === req.username) return res.status(400).json({ error: 'Use Leave Group to remove yourself.' });

        await pgPool.query('DELETE FROM group_members WHERE group_id = $1 AND username = $2', [groupId, target]);

        const group = serializeGroup(await getGroupOrNull(groupId));
        const members = await getGroupMembers(groupId);
        const payload = { group, members, removedUsername: target, byUsername: req.username };
        await pushToUserSocket(target, 'group_removed_self', payload);
        for (const m of members) {
            await pushToUserSocket(m.username, 'group_member_removed', payload);
        }
        res.json({ ok: true, members });
    } catch (err) {
        console.error('groups/:id/remove-member failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/groups/:id/leave', requireAuth, async (req, res) => {
    try {
        const groupId = req.params.id;
        const role = await getGroupRole(groupId, req.username);
        if (!role) return res.status(400).json({ error: 'You are not a member of this group.' });

        await pgPool.query('DELETE FROM group_members WHERE group_id = $1 AND username = $2', [groupId, req.username]);

        let members = await getGroupMembers(groupId);
        // A group should never end up with members but no admin -- if the last admin
        // just left, hand the role to whoever's been there longest.
        if (members.length && role === 'admin' && !members.some(m => m.role === 'admin')) {
            await pgPool.query("UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND username = $2", [groupId, members[0].username]);
            members = await getGroupMembers(groupId);
        }
        if (!members.length) {
            await pgPool.query('DELETE FROM groups WHERE id = $1', [groupId]);
        }

        const group = serializeGroup(await getGroupOrNull(groupId));
        const payload = { groupId, members, byUsername: req.username };
        for (const m of members) {
            await pushToUserSocket(m.username, 'group_member_left', { ...payload, group });
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('groups/:id/leave failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/groups/:id/set-role', requireAuth, async (req, res) => {
    try {
        const groupId = req.params.id;
        const role = await getGroupRole(groupId, req.username);
        if (role !== 'admin') return res.status(403).json({ error: 'Only admins can change roles.' });

        const target = String((req.body || {}).username || '').trim().toLowerCase();
        const newRole = (req.body || {}).role === 'admin' ? 'admin' : 'member';
        if (!target) return res.status(400).json({ error: 'username is required.' });

        const targetRole = await getGroupRole(groupId, target);
        if (!targetRole) return res.status(404).json({ error: 'That user is not in this group.' });

        await pgPool.query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND username = $3', [newRole, groupId, target]);

        const group = serializeGroup(await getGroupOrNull(groupId));
        const members = await getGroupMembers(groupId);
        const payload = { group, members, byUsername: req.username };
        for (const m of members) {
            await pushToUserSocket(m.username, 'group_updated', payload);
        }
        res.json({ ok: true, members });
    } catch (err) {
        console.error('groups/:id/set-role failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Invite codes are redeemed by a logged-in user via /api/groups/join/:code (not a
// public unauthenticated URL) -- keeps this simple and still gated behind having
// an account, rather than standing up a separate public join page.
app.post('/api/groups/:id/invite', requireAuth, async (req, res) => {
    try {
        const groupId = req.params.id;
        const role = await getGroupRole(groupId, req.username);
        if (!role) return res.status(403).json({ error: 'Not a member of this group.' });
        const group = await getGroupOrNull(groupId);
        if (!group) return res.status(404).json({ error: 'Group not found.' });
        if (group.only_admins_can_manage && role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can create invite links for this group.' });
        }

        const code = crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await pgPool.query(
            'INSERT INTO group_invites (code, group_id, created_by, expires_at) VALUES ($1, $2, $3, $4)',
            [code, groupId, req.username, expiresAt]
        );
        res.json({ ok: true, code, expiresAt });
    } catch (err) {
        console.error('groups/:id/invite failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/groups/join/:code', requireAuth, async (req, res) => {
    try {
        const code = req.params.code;
        const inviteRow = await pgPool.query('SELECT * FROM group_invites WHERE code = $1', [code]);
        if (!inviteRow.rows.length) return res.status(404).json({ error: 'That invite link is invalid.' });
        const invite = inviteRow.rows[0];
        if (invite.revoked) return res.status(410).json({ error: 'That invite link has been revoked.' });
        if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
            return res.status(410).json({ error: 'That invite link has expired.' });
        }

        const groupRow = await getGroupOrNull(invite.group_id);
        if (!groupRow) return res.status(404).json({ error: 'This group no longer exists.' });
        const group = serializeGroup(groupRow);

        const alreadyMember = await getGroupRole(invite.group_id, req.username);
        if (!alreadyMember) {
            await pgPool.query(
                "INSERT INTO group_members (group_id, username, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
                [invite.group_id, req.username]
            );
        }

        const members = await getGroupMembers(invite.group_id);
        const payload = { group, members, addedUsernames: [req.username], addedBy: req.username };
        for (const m of members) {
            if (m.username === req.username) continue;
            await pushToUserSocket(m.username, 'group_members_added', payload);
        }
        res.json({ ok: true, group, members });
    } catch (err) {
        console.error('groups/join failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.delete('/api/groups/:id/invite/:code', requireAuth, async (req, res) => {
    try {
        const groupId = req.params.id;
        const role = await getGroupRole(groupId, req.username);
        if (!role) return res.status(403).json({ error: 'Not a member of this group.' });
        await pgPool.query('UPDATE group_invites SET revoked = true WHERE code = $1 AND group_id = $2', [req.params.code, groupId]);
        res.json({ ok: true });
    } catch (err) {
        console.error('groups/:id/invite revoke failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

const BACKUP_RATE_LIMIT = 5;
const BACKUP_RATE_WINDOW = 60 * 60; // 1 hour

app.post('/api/auth/backup-email', requireAuth, async (req, res) => {
    const { filename, base64Blob } = req.body || {};
    if (!filename || !base64Blob || typeof base64Blob !== 'string') {
        return res.status(400).json({ error: 'filename and base64Blob are required.' });
    }
    // ~15MB base64 guardrail mirrored server-side (client already enforces this, but don't trust it alone)
    if (base64Blob.length > 20 * 1024 * 1024) {
        return res.status(413).json({ error: 'Backup is too large to email.' });
    }

    const withinLimit = await checkAndBumpRateLimit(`ratelimit:backup:${req.username}`, BACKUP_RATE_LIMIT, BACKUP_RATE_WINDOW);
    if (!withinLimit) {
        return res.status(429).json({ error: 'Too many backup emails requested. Please try again later.' });
    }

    try {
        const result = await pgPool.query('SELECT email FROM users WHERE username = $1', [req.username]);
        if (!result.rows.length) return res.status(404).json({ error: 'Account not found.' });

        if (resend) {
            await resend.emails.send({
                from: 'HAI <noreply@myhai.org>',
                to: result.rows[0].email,
                subject: 'Your HAI encrypted chat backup',
                text: 'Attached is an encrypted backup of your HAI chat history. It can only be restored inside the HAI app using your account password. Do not share this file.',
                attachments: [{ filename, content: Buffer.from(base64Blob, 'base64') }]
            });
        } else {
            console.warn('RESEND_API_KEY not set — backup email not sent.');
            return res.status(503).json({ error: 'Email backend is not configured.' });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('backup-email failed:', err.message);
        res.status(500).json({ error: 'Something went wrong sending your backup. Please try again.' });
    }
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 8 * 1024 * 1024, // allow encrypted photo/voice-note/document payloads through
    // Socket.IO attaches straight to the http server and never passes through the
    // Express app, so the Basic Auth middleware above doesn't cover it -- without
    // this, the auth gate could be bypassed entirely by talking to the socket
    // handshake directly instead of loading the page first.
    allowRequest: (req, callback) => {
        if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return callback(null, true);
        const header = req.headers.authorization || '';
        const [scheme, encoded] = header.split(' ');
        if (scheme === 'Basic' && encoded) {
            const decoded = Buffer.from(encoded, 'base64').toString('utf8');
            const sepIdx = decoded.indexOf(':');
            const user = Buffer.from(decoded.slice(0, sepIdx));
            const pass = Buffer.from(decoded.slice(sepIdx + 1));
            const expectedUser = Buffer.from(BASIC_AUTH_USER);
            const expectedPass = Buffer.from(BASIC_AUTH_PASS);
            const userOk = user.length === expectedUser.length && crypto.timingSafeEqual(user, expectedUser);
            const passOk = pass.length === expectedPass.length && crypto.timingSafeEqual(pass, expectedPass);
            if (userOk && passOk) return callback(null, true);
        }
        callback(null, false);
    }
});

const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redisClient.connect().then(() => console.log('🌪️ Redis connected')).catch(err => console.error(err));

/* VOICE CALLING — signaling state (MYAG-218-BE). All state lives in this one
   process's memory (see calls.js) since Socket.IO here has no cross-instance
   adapter, so socket routing is already process-local -- consistent with that.
   isContact reuses the same friendship table messaging is already gated behind;
   onCallMissed is the only place a ring-timeout notifies both sides that a call
   nobody answered is now `missed`, so nothing can stay `ringing` forever. */
const callManager = createCallManager({
    getUserSockets,
    isContact: areFriends,
    ringTimeoutMs: Number(process.env.CALL_RING_TIMEOUT_MS) > 0 ? Number(process.env.CALL_RING_TIMEOUT_MS) : undefined,
    onCallMissed: async (call) => {
        for (const sid of await getUserSockets(call.caller)) io.to(sid).emit('call:missed', { callId: call.callId });
        for (const sid of await getUserSockets(call.callee)) io.to(sid).emit('call:missed', { callId: call.callId });
        logAnalyticsEvent('call_missed', call.caller);
    },
});

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
const NEARBY_GEO_TTL = 60 * 15; // 15 min — location goes stale fast; re-sent each time the Nearby tab is opened
const NEARBY_RADIUS_MILES = 10;

// Great-circle distance between two lat/lng points, in miles.
function haversineMiles(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * Math.PI / 180;
    const R = 3958.8; // Earth radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
        for (const sid of await getUserSockets(username)) io.to(sid).emit('nearby_match_expired', { matchId });
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

/* ============ ADMIN ANALYTICS DASHBOARD ============
   Everything here is gated behind requireAuth + requireAdmin. Metrics are always
   computed from analytics_events (see logAnalyticsEvent above) plus a couple of
   live point-in-time counts (online now, total users/groups) -- never from
   message content, which the server never has access to. */

const ANALYTICS_METRICS = {
    signups: { label: 'Signups', eventTypes: ['signup'], distinctUser: false },
    logins: { label: 'Logins', eventTypes: ['login'], distinctUser: false },
    messages_1to1: { label: '1:1 Messages Sent', eventTypes: ['message_sent'], distinctUser: false },
    messages_group: { label: 'Group Messages Sent', eventTypes: ['group_message_sent'], distinctUser: false },
    messages_total: { label: 'Total Messages Sent', eventTypes: ['message_sent', 'group_message_sent'], distinctUser: false },
    messages_blocked: { label: 'Messages Blocked', eventTypes: ['message_blocked'], distinctUser: false },
    groups_created: { label: 'Groups Created', eventTypes: ['group_created'], distinctUser: false },
    friend_connections: { label: 'New Friend Connections', eventTypes: ['friend_connected'], distinctUser: false },
    active_users: { label: 'Active Users (DAU)', eventTypes: null, distinctUser: true },
    nearby_matches: { label: 'Nearby Matches', eventTypes: ['nearby_match_created'], distinctUser: false },
    games_started: { label: 'Games Started (All)', eventTypes: ['game_tictactoe_started', 'game_rps_started', 'game_truthdare_started', 'game_connect4_started', 'game_wordchain_started', 'game_hangman_started', 'game_wyr_started', 'game_twentyq_started', 'game_emojicharades_started', 'game_trivia_started', 'game_dotsboxes_started'], distinctUser: false },
    games_tictactoe: { label: 'Tic Tac Toe Started', eventTypes: ['game_tictactoe_started'], distinctUser: false },
    games_rps: { label: 'Rock-Paper-Scissors Started', eventTypes: ['game_rps_started'], distinctUser: false },
    games_truthdare: { label: 'Truth or Dare Started', eventTypes: ['game_truthdare_started'], distinctUser: false },
    games_connect4: { label: 'Connect Four Started', eventTypes: ['game_connect4_started'], distinctUser: false },
    games_wordchain: { label: 'Word Chain Started', eventTypes: ['game_wordchain_started'], distinctUser: false },
    games_hangman: { label: 'Hangman Started', eventTypes: ['game_hangman_started'], distinctUser: false },
    games_wyr: { label: 'Would You Rather Started', eventTypes: ['game_wyr_started'], distinctUser: false },
    games_twentyq: { label: '20 Questions Started', eventTypes: ['game_twentyq_started'], distinctUser: false },
    games_emojicharades: { label: 'Emoji Charades Started', eventTypes: ['game_emojicharades_started'], distinctUser: false },
    games_trivia: { label: 'Trivia Quiz Started', eventTypes: ['game_trivia_started'], distinctUser: false },
    games_dotsboxes: { label: 'Dots and Boxes Started', eventTypes: ['game_dotsboxes_started'], distinctUser: false },
    voice_notes_sent: { label: 'Voice Notes Sent', eventTypes: ['voice_note_sent'], distinctUser: false },
    photos_sent: { label: 'Photos Sent', eventTypes: ['photo_sent'], distinctUser: false },
    documents_sent: { label: 'Documents Sent', eventTypes: ['document_sent'], distinctUser: false },
};

// Returns a full day-by-day series over the requested range, zero-filling days
// with no events so a chart never shows a misleading gap as "no data yet".
async function getTimeseries(metricKey, daysParam) {
    const metric = ANALYTICS_METRICS[metricKey];
    if (!metric) return null;
    const days = Math.max(1, Math.min(365, parseInt(daysParam, 10) || 30));

    const selectCol = metric.distinctUser ? 'COUNT(DISTINCT username)' : 'COUNT(*)';
    const typeClause = metric.eventTypes ? 'AND event_type = ANY($2)' : '';
    const params = metric.eventTypes ? [String(days), metric.eventTypes] : [String(days)];
    const sql = `
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, ${selectCol} AS value
        FROM analytics_events
        WHERE created_at >= now() - ($1 || ' days')::interval ${typeClause}
        GROUP BY day ORDER BY day
    `;
    const result = await pgPool.query(sql, params);
    const byDay = {};
    result.rows.forEach(r => { byDay[r.day] = parseInt(r.value, 10); });

    const series = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        series.push({ date: key, value: byDay[key] || 0 });
    }
    return series;
}

app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [onlineNow, totalUsersRow, totalGroupsRow, messagesTodayRow, signupsTodayRow, messages7dRow, signups7dRow] = await Promise.all([
            redisClient.sCard('online_users'),
            pgPool.query('SELECT COUNT(*) FROM users'),
            pgPool.query('SELECT COUNT(*) FROM groups'),
            pgPool.query(`SELECT COUNT(*) FROM analytics_events WHERE event_type IN ('message_sent', 'group_message_sent') AND created_at >= date_trunc('day', now())`),
            pgPool.query(`SELECT COUNT(*) FROM analytics_events WHERE event_type = 'signup' AND created_at >= date_trunc('day', now())`),
            pgPool.query(`SELECT COUNT(*) FROM analytics_events WHERE event_type IN ('message_sent', 'group_message_sent') AND created_at >= now() - interval '7 days'`),
            pgPool.query(`SELECT COUNT(*) FROM analytics_events WHERE event_type = 'signup' AND created_at >= now() - interval '7 days'`)
        ]);
        res.json({
            onlineNow,
            totalUsers: parseInt(totalUsersRow.rows[0].count, 10),
            totalGroups: parseInt(totalGroupsRow.rows[0].count, 10),
            messagesToday: parseInt(messagesTodayRow.rows[0].count, 10),
            signupsToday: parseInt(signupsTodayRow.rows[0].count, 10),
            messages7d: parseInt(messages7dRow.rows[0].count, 10),
            signups7d: parseInt(signups7dRow.rows[0].count, 10)
        });
    } catch (err) {
        console.error('admin/overview failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.get('/api/admin/metrics', requireAuth, requireAdmin, (req, res) => {
    res.json({ metrics: Object.entries(ANALYTICS_METRICS).map(([key, m]) => ({ key, label: m.label })) });
});

app.get('/api/admin/timeseries', requireAuth, requireAdmin, async (req, res) => {
    try {
        const series = await getTimeseries(req.query.metric, req.query.days);
        if (!series) return res.status(400).json({ error: 'Unknown metric.' });
        res.json({ metric: req.query.metric, series });
    } catch (err) {
        console.error('admin/timeseries failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.get('/api/admin/export', requireAuth, requireAdmin, async (req, res) => {
    try {
        const series = await getTimeseries(req.query.metric, req.query.days);
        if (!series) return res.status(400).json({ error: 'Unknown metric.' });
        const csv = 'date,value\n' + series.map(r => `${r.date},${r.value}`).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${req.query.metric}.csv"`);
        res.send(csv);
    } catch (err) {
        console.error('admin/export failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Event types that count as "active" for DAU/WAU/MAU — any meaningful user action.
// Excludes 'signup' (one-time registration, not ongoing engagement) and 'message_blocked' (failed attempt).
const ACTIVE_EVENT_TYPES = [
    'login', 'message_sent', 'group_message_sent', 'friend_connected', 'group_created',
    'game_tictactoe_started', 'game_rps_started', 'game_truthdare_started',
    'game_connect4_started', 'game_wordchain_started', 'game_hangman_started', 'game_wyr_started',
    'game_twentyq_started', 'game_emojicharades_started', 'game_trivia_started', 'game_dotsboxes_started',
    'nearby_match_created', 'voice_note_sent', 'photo_sent', 'document_sent',
];

// Growth & engagement: DAU/WAU/MAU and signup counts over configurable windows.
app.get('/api/admin/growth', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [dauRow, wauRow, mauRow, signupsTodayRow, signups7dRow, signups30dRow] = await Promise.all([
            pgPool.query(
                `SELECT COUNT(DISTINCT username) FROM analytics_events WHERE event_type = ANY($1) AND created_at >= now() - interval '1 day'`,
                [ACTIVE_EVENT_TYPES]
            ),
            pgPool.query(
                `SELECT COUNT(DISTINCT username) FROM analytics_events WHERE event_type = ANY($1) AND created_at >= now() - interval '7 days'`,
                [ACTIVE_EVENT_TYPES]
            ),
            pgPool.query(
                `SELECT COUNT(DISTINCT username) FROM analytics_events WHERE event_type = ANY($1) AND created_at >= now() - interval '30 days'`,
                [ACTIVE_EVENT_TYPES]
            ),
            pgPool.query(`SELECT COUNT(*) FROM analytics_events WHERE event_type = 'signup' AND created_at >= date_trunc('day', now())`),
            pgPool.query(`SELECT COUNT(*) FROM analytics_events WHERE event_type = 'signup' AND created_at >= now() - interval '7 days'`),
            pgPool.query(`SELECT COUNT(*) FROM analytics_events WHERE event_type = 'signup' AND created_at >= now() - interval '30 days'`),
        ]);
        res.json({
            // "Active" = any event in ACTIVE_EVENT_TYPES (login, messages, games, nearby, media).
            // Excludes signup-only users who never returned after registering.
            activeDefinition: 'Any login, message, game, nearby-match, or media event within the window',
            dau: parseInt(dauRow.rows[0].count, 10),
            wau: parseInt(wauRow.rows[0].count, 10),
            mau: parseInt(mauRow.rows[0].count, 10),
            signupsToday: parseInt(signupsTodayRow.rows[0].count, 10),
            signups7d: parseInt(signups7dRow.rows[0].count, 10),
            signups30d: parseInt(signups30dRow.rows[0].count, 10),
        });
    } catch (err) {
        console.error('admin/growth failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Retention cohorts: for each day users signed up, what fraction had any active event
// on day+1, day+7, and day+30 after signup. Returns cohorts for the last `days` signup days.
app.get('/api/admin/retention', requireAuth, requireAdmin, async (req, res) => {
    try {
        const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
        // For each signup day, count users and how many had any ACTIVE_EVENT_TYPES event
        // at least 1/7/30 days after their signup date.
        const result = await pgPool.query(`
            WITH signup_cohorts AS (
                SELECT
                    date_trunc('day', created_at) AS cohort_day,
                    username
                FROM analytics_events
                WHERE event_type = 'signup'
                  AND created_at >= now() - ($1 || ' days')::interval
            ),
            active_events AS (
                SELECT username, created_at FROM analytics_events WHERE event_type = ANY($2)
            )
            SELECT
                to_char(c.cohort_day, 'YYYY-MM-DD') AS date,
                COUNT(DISTINCT c.username) AS signups,
                COUNT(DISTINCT CASE WHEN ae1.username IS NOT NULL THEN c.username END) AS d1,
                COUNT(DISTINCT CASE WHEN ae7.username IS NOT NULL THEN c.username END) AS d7,
                COUNT(DISTINCT CASE WHEN ae30.username IS NOT NULL THEN c.username END) AS d30
            FROM signup_cohorts c
            LEFT JOIN active_events ae1 ON ae1.username = c.username
                AND ae1.created_at >= c.cohort_day + interval '1 day'
                AND ae1.created_at < c.cohort_day + interval '2 days'
            LEFT JOIN active_events ae7 ON ae7.username = c.username
                AND ae7.created_at >= c.cohort_day + interval '7 days'
                AND ae7.created_at < c.cohort_day + interval '8 days'
            LEFT JOIN active_events ae30 ON ae30.username = c.username
                AND ae30.created_at >= c.cohort_day + interval '30 days'
                AND ae30.created_at < c.cohort_day + interval '31 days'
            GROUP BY c.cohort_day ORDER BY c.cohort_day
        `, [String(days), ACTIVE_EVENT_TYPES]);
        res.json({
            cohorts: result.rows.map(r => ({
                date: r.date,
                signups: parseInt(r.signups, 10),
                d1: parseInt(r.d1, 10),
                d7: parseInt(r.d7, 10),
                d30: parseInt(r.d30, 10),
            }))
        });
    } catch (err) {
        console.error('admin/retention failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Feature usage summary: counts for games, nearby, media, and message delivery health.
// Accepts ?days=N (default 30). Reuses analytics_events; no realtime Redis state needed.
app.get('/api/admin/feature-usage', requireAuth, requireAdmin, async (req, res) => {
    try {
        const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
        const since = `now() - ($1 || ' days')::interval`;
        const [gameRows, nearbyRow, mediaRows, sentRow, blockedRow] = await Promise.all([
            pgPool.query(
                `SELECT event_type, COUNT(*) AS cnt FROM analytics_events
                 WHERE event_type IN ('game_tictactoe_started','game_rps_started','game_truthdare_started',
                                       'game_connect4_started','game_wordchain_started','game_hangman_started',
                                       'game_wyr_started','game_twentyq_started','game_emojicharades_started',
                                       'game_trivia_started','game_dotsboxes_started')
                   AND created_at >= ${since} GROUP BY event_type`,
                [String(days)]
            ),
            pgPool.query(
                `SELECT COUNT(*) FROM analytics_events WHERE event_type = 'nearby_match_created' AND created_at >= ${since}`,
                [String(days)]
            ),
            pgPool.query(
                `SELECT event_type, COUNT(*) AS cnt FROM analytics_events
                 WHERE event_type IN ('voice_note_sent','photo_sent','document_sent')
                   AND created_at >= ${since} GROUP BY event_type`,
                [String(days)]
            ),
            pgPool.query(
                `SELECT COUNT(*) FROM analytics_events WHERE event_type IN ('message_sent','group_message_sent') AND created_at >= ${since}`,
                [String(days)]
            ),
            pgPool.query(
                `SELECT COUNT(*) FROM analytics_events WHERE event_type = 'message_blocked' AND created_at >= ${since}`,
                [String(days)]
            ),
        ]);

        const gameCounts = {
            tictactoe: 0, rps: 0, truthdare: 0, connect4: 0, wordchain: 0,
            hangman: 0, wyr: 0, twentyq: 0, emojicharades: 0, trivia: 0, dotsboxes: 0,
        };
        gameRows.rows.forEach(r => {
            const key = r.event_type.replace(/^game_/, '').replace(/_started$/, '');
            if (key in gameCounts) gameCounts[key] = parseInt(r.cnt, 10);
        });

        const mediaCounts = { voiceNotes: 0, photos: 0, documents: 0 };
        mediaRows.rows.forEach(r => {
            if (r.event_type === 'voice_note_sent') mediaCounts.voiceNotes = parseInt(r.cnt, 10);
            else if (r.event_type === 'photo_sent') mediaCounts.photos = parseInt(r.cnt, 10);
            else if (r.event_type === 'document_sent') mediaCounts.documents = parseInt(r.cnt, 10);
        });

        const totalSent = parseInt(sentRow.rows[0].count, 10);
        const totalBlocked = parseInt(blockedRow.rows[0].count, 10);

        res.json({
            period: `${days}d`,
            gamesStarted: { ...gameCounts, total: gameCounts.tictactoe + gameCounts.rps + gameCounts.truthdare },
            nearbyMatches: parseInt(nearbyRow.rows[0].count, 10),
            mediaShared: mediaCounts,
            messageDelivery: {
                sent: totalSent,
                blocked: totalBlocked,
                blockRate: (totalSent + totalBlocked) > 0 ? +(totalBlocked / (totalSent + totalBlocked)).toFixed(4) : 0,
            },
            technicalHealthGaps: [
                'error_rate: no structured HTTP error logging in current schema; would need request-level middleware instrumentation',
                'container_metrics: CPU/mem not available from inside the app container without external tooling (cAdvisor, Docker stats API, etc.)',
            ],
        });
    } catch (err) {
        console.error('admin/feature-usage failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.get('/api/admin/dashboards', requireAuth, requireAdmin, async (req, res) => {
    try {
        const r = await pgPool.query('SELECT id, name, layout, updated_at FROM admin_dashboards WHERE created_by = $1 ORDER BY created_at ASC', [req.username]);
        res.json({ dashboards: r.rows.map(row => ({ id: row.id, name: row.name, layout: row.layout, updatedAt: row.updated_at })) });
    } catch (err) {
        console.error('admin/dashboards get failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/admin/dashboards', requireAuth, requireAdmin, async (req, res) => {
    try {
        const name = String((req.body || {}).name || 'New Dashboard').trim().slice(0, 100) || 'New Dashboard';
        const layout = Array.isArray((req.body || {}).layout) ? req.body.layout : [];
        const id = crypto.randomUUID();
        await pgPool.query('INSERT INTO admin_dashboards (id, created_by, name, layout) VALUES ($1, $2, $3, $4)', [id, req.username, name, JSON.stringify(layout)]);
        res.json({ ok: true, id });
    } catch (err) {
        console.error('admin/dashboards create failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.patch('/api/admin/dashboards/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const own = await pgPool.query('SELECT 1 FROM admin_dashboards WHERE id = $1 AND created_by = $2', [req.params.id, req.username]);
        if (!own.rows.length) return res.status(404).json({ error: 'Dashboard not found.' });

        const updates = [];
        const values = [];
        if (typeof (req.body || {}).name === 'string') {
            values.push(req.body.name.trim().slice(0, 100));
            updates.push(`name = $${values.length}`);
        }
        if (Array.isArray((req.body || {}).layout)) {
            values.push(JSON.stringify(req.body.layout));
            updates.push(`layout = $${values.length}`);
        }
        if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });
        updates.push('updated_at = now()');

        values.push(req.params.id);
        await pgPool.query(`UPDATE admin_dashboards SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
        res.json({ ok: true });
    } catch (err) {
        console.error('admin/dashboards update failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.delete('/api/admin/dashboards/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await pgPool.query('DELETE FROM admin_dashboards WHERE id = $1 AND created_by = $2', [req.params.id, req.username]);
        res.json({ ok: true });
    } catch (err) {
        console.error('admin/dashboards delete failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.get('/api/admin/reports', requireAuth, requireAdmin, async (req, res) => {
    try {
        const r = await pgPool.query(
            `SELECT r.id, r.dashboard_id, r.email, r.frequency, r.last_sent_at, d.name AS dashboard_name
             FROM admin_scheduled_reports r JOIN admin_dashboards d ON d.id = r.dashboard_id
             WHERE r.created_by = $1 ORDER BY r.created_at ASC`,
            [req.username]
        );
        res.json({
            reports: r.rows.map(row => ({
                id: row.id, dashboardId: row.dashboard_id, dashboardName: row.dashboard_name,
                email: row.email, frequency: row.frequency, lastSentAt: row.last_sent_at
            })),
            emailEnabled: !!resend
        });
    } catch (err) {
        console.error('admin/reports get failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.post('/api/admin/reports', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { dashboardId, email, frequency } = req.body || {};
        if (!dashboardId || !email || !EMAIL_PATTERN.test(email)) {
            return res.status(400).json({ error: 'A dashboard and a valid email are required.' });
        }
        const own = await pgPool.query('SELECT 1 FROM admin_dashboards WHERE id = $1 AND created_by = $2', [dashboardId, req.username]);
        if (!own.rows.length) return res.status(404).json({ error: 'Dashboard not found.' });

        const freq = frequency === 'daily' ? 'daily' : 'weekly';
        const id = crypto.randomUUID();
        await pgPool.query(
            'INSERT INTO admin_scheduled_reports (id, dashboard_id, created_by, email, frequency) VALUES ($1, $2, $3, $4, $5)',
            [id, dashboardId, req.username, email.trim().toLowerCase(), freq]
        );
        res.json({ ok: true, id });
    } catch (err) {
        console.error('admin/reports create failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

app.delete('/api/admin/reports/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await pgPool.query('DELETE FROM admin_scheduled_reports WHERE id = $1 AND created_by = $2', [req.params.id, req.username]);
        res.json({ ok: true });
    } catch (err) {
        console.error('admin/reports delete failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Hourly due-check: a report fires once its last send is older than its
// frequency window (or it's never been sent). Skipped entirely if no
// RESEND_API_KEY is configured -- reports still save fine, they just won't
// deliver until email is set up, same posture as verification email.
async function sendScheduledReports() {
    if (!resend) return;
    try {
        const due = await pgPool.query(`
            SELECT r.*, d.name AS dashboard_name, d.layout FROM admin_scheduled_reports r
            JOIN admin_dashboards d ON d.id = r.dashboard_id
            WHERE (r.last_sent_at IS NULL)
               OR (r.frequency = 'daily' AND r.last_sent_at < now() - interval '1 day')
               OR (r.frequency = 'weekly' AND r.last_sent_at < now() - interval '7 days')
        `);
        for (const report of due.rows) {
            const widgets = Array.isArray(report.layout) ? report.layout : [];
            let rowsHtml = '';
            for (const w of widgets) {
                const series = await getTimeseries(w.metric, w.rangeDays || 7);
                if (!series) continue;
                const total = series.reduce((sum, p) => sum + p.value, 0);
                const metricLabel = (ANALYTICS_METRICS[w.metric] || {}).label || w.metric;
                rowsHtml += `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;">${w.title || metricLabel}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${total}</td></tr>`;
            }
            const html = `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="margin-bottom:4px;">${report.dashboard_name}</h2>
                    <p style="color:#888;margin-top:0;">${report.frequency === 'daily' ? 'Daily' : 'Weekly'} report — totals over the widget's own date range</p>
                    <table style="width:100%;border-collapse:collapse;">${rowsHtml}</table>
                    <p style="color:#aaa;font-size:12px;margin-top:16px;">Sent by your HAI Admin Dashboard</p>
                </div>`;
            try {
                await resend.emails.send({
                    from: 'HAI <noreply@myhai.org>',
                    to: report.email,
                    subject: `${report.dashboard_name} — ${report.frequency} report`,
                    html
                });
                await pgPool.query('UPDATE admin_scheduled_reports SET last_sent_at = now() WHERE id = $1', [report.id]);
            } catch (err) {
                console.error('Failed to send scheduled report:', err.message);
            }
        }
    } catch (err) {
        console.error('Scheduled report sweep failed:', err.message);
    }
}
setInterval(sendScheduledReports, 60 * 60 * 1000);

/* ============ THEME SETTINGS ============
   Colors-only admin override for the five brand/background CSS tokens.
   GET /api/theme is public and cached in-memory — it's on every page-load's
   hot path. PUT /api/admin/theme uses a strict allowlist regex so an admin
   can't inject arbitrary CSS into every user's page. */

// Strict allowlist: clean hex (#rgb, #rrggbb, #rrggbbaa) or plain rgb/rgba
// with numeric-only components. Rejects CSS functions, selectors, variables,
// and any other free-form text.
const COLOR_REGEX = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\))$/;

const THEME_TOKENS = ['accentBrand', 'accentBrandHover', 'bgMain', 'bgChat', 'bgSidebar'];

const THEME_DEFAULTS = {
    light: {
        accentBrand: '#6C5DD3',
        accentBrandHover: '#5847B8',
        bgMain: '#EEECF7',
        bgChat: '#FAF7F2',
        bgSidebar: '#FBFAFE',
    },
    dark: {
        accentBrand: '#9B8AFB',
        accentBrandHover: '#8171E8',
        bgMain: '#09090b',
        bgChat: '#0a0a0c',
        bgSidebar: '#0d0d10',
    }
};

// In-memory cache for the effective theme — invalidated on every successful PUT.
// Avoids a Postgres round-trip on every page load for a rarely-changing config.
let themeCache = null;

async function getEffectiveTheme() {
    if (themeCache) return themeCache;
    const rows = await pgPool.query('SELECT key, value FROM app_theme_settings');
    const overrides = {};
    for (const row of rows.rows) overrides[row.key] = row.value;
    const theme = {
        light: { ...THEME_DEFAULTS.light },
        dark:  { ...THEME_DEFAULTS.dark  }
    };
    for (const mode of ['light', 'dark']) {
        for (const token of THEME_TOKENS) {
            const k = `${mode}.${token}`;
            if (overrides[k]) theme[mode][token] = overrides[k];
        }
    }
    themeCache = theme;
    return theme;
}

// Public — fetched on every page load to apply the current brand colors.
app.get('/api/theme', async (req, res) => {
    try {
        const theme = await getEffectiveTheme();
        res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        res.json(theme);
    } catch (err) {
        console.error('GET /api/theme failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Admin — prefills the color pickers in the admin panel.
app.get('/api/admin/theme', requireAuth, requireAdmin, async (req, res) => {
    try {
        res.json(await getEffectiveTheme());
    } catch (err) {
        console.error('GET /api/admin/theme failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Admin — persists theme color overrides. Partial updates accepted; only
// keys present in the body are written. Every value is validated before any
// write occurs, so a mixed-valid/invalid body is rejected atomically.
app.put('/api/admin/theme', requireAuth, requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const invalid = [];
        const writes = [];

        for (const mode of ['light', 'dark']) {
            const modeBody = body[mode];
            if (!modeBody || typeof modeBody !== 'object') continue;
            for (const token of THEME_TOKENS) {
                if (!(token in modeBody)) continue;
                const val = modeBody[token];
                if (typeof val !== 'string' || !COLOR_REGEX.test(val.trim())) {
                    invalid.push(`${mode}.${token}`);
                } else {
                    writes.push({ key: `${mode}.${token}`, value: val.trim() });
                }
            }
        }

        if (invalid.length) {
            return res.status(400).json({ error: 'Invalid color value(s)', fields: invalid });
        }
        if (!writes.length) {
            return res.status(400).json({ error: 'No valid theme tokens provided.' });
        }

        for (const { key, value } of writes) {
            await pgPool.query(
                `INSERT INTO app_theme_settings (key, value, updated_at)
                 VALUES ($1, $2, now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                [key, value]
            );
        }
        themeCache = null;
        res.json({ ok: true });
    } catch (err) {
        console.error('PUT /api/admin/theme failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

/* ============ MIKA BRIDGE — admin-only Multica agent chat ============
   Security contract (MYAG-127), implementation (MYAG-130):
   - Every request passes requireAuth (JWT) then requireAdmin (DB is_admin check).
     UI hiding is NOT the gate — the server enforces this independently.
   - Multica is reached ONLY through the `multica` CLI (execFile with an argv
     array — never a shell, never string-concatenated). This is the one
     supported, verified integration surface for the platform; there is no
     documented public Multica REST API to call directly instead. The CLI
     must be installed and authenticated (as a scoped service identity with
     permission to create/assign issues in the configured project) on the
     host/container running this server — see .env.example for the runtime
     env vars and the manual provisioning note.
   - The admin's message reaches Multica only via a temp file passed to
     `--description-file`; it is never interpolated into a shell command or
     used to build the argv array itself, so there is no injection vector.
   - The workspace/project/agent/parent-issue allowlist is hard-wired to env
     vars checked at startup; every created issue is re-fetched and verified
     against that allowlist before it is trusted, and only a top-level
     'comment' authored by MIKA_AGENT_ID on that exact issue is ever relayed.
   - Requests are processed asynchronously: the endpoint ACKs with 202 and a
     requestId immediately, then a background poll creates the Multica issue
     and watches for Mika's reply, pushing the result over Socket.IO to the
     admin's own connected sockets (existing pushToUserSocket registry —
     already identity-scoped via the JWT-verified register_user handshake).
   - Every request/reply/status is persisted in mika_bridge_requests, so a
     server restart resumes in-flight polls (see recoverPendingMikaRequests)
     instead of silently losing them, and the admin UI can restore history
     across refresh/reconnect via GET /api/admin/mika/requests.
   - Idempotency: identical (admin, message) within a 5-minute window reuses
     the existing pending/completed row instead of creating a duplicate issue.
   - Rate limits: IP-level (express-rate-limit) + per-user Redis counter.
   - Every send is logged to analytics_events ('mika_message_sent') for audit.
   - CLI stderr/stdout is never forwarded to the client on failure — only a
     generic message; the real error is logged server-side only.

   Threat model (abbreviated):
   ┌─────────────────────────────────────────────────┬────────────────────────────────────────────────────┐
   │ Threat                                          │ Mitigation                                         │
   ├─────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
   │ Non-admin user calls the endpoint               │ requireAuth + requireAdmin (DB check, not JWT-only)│
   │ Admin JWT stolen/replayed                       │ httpOnly cookie; is_admin still re-checked from DB │
   │ Message text injected into the Multica call     │ execFile argv array + description FILE; no shell  │
   │ Reply relayed from wrong issue/author           │ Created issue re-verified; comment filtered by     │
   │                                                  │ agent id + issue id before being trusted           │
   │ Spam creating thousands of Multica issues        │ 5/10 min per-user + 10/15 min IP rate limit        │
   │ Retry storm duplicating issues                  │ Persisted content-hash idempotency (5 min window)  │
   │ Wrong workspace/project targeted                │ Env-var allowlist; startup warning if unset        │
   │ Hung request from slow/offline Multica          │ Async design — HTTP request never blocks on it;    │
   │                                                  │ background poll gives up after MIKA_REPLY_TIMEOUT  │
   │ Server restart loses an in-flight request       │ Persisted row + recoverPendingMikaRequests on boot │
   │ Non-admin receives another admin's reply        │ Delivery targets only the requesting admin's own   │
   │                                                  │ registered sockets/username, never broadcast        │
   │ Credentials committed to git                    │ .env gitignored; .env.example has placeholders only│
   └─────────────────────────────────────────────────┴────────────────────────────────────────────────────┘ */

const MIKA_CONFIG = loadMikaConfig();
const MIKA_CONFIGURED = isMikaConfigured(MIKA_CONFIG);
if (!MIKA_CONFIGURED) {
    console.warn('⚠️  Mika bridge disabled — missing one of MULTICA_PROJECT_ID / MIKA_AGENT_ID / MIKA_PARENT_ISSUE_ID');
}

function mikaCliArgs(subArgs) {
    return MIKA_CONFIG.workspaceId ? ['--workspace-id', MIKA_CONFIG.workspaceId, ...subArgs] : subArgs;
}

// Every Multica call goes through here so there is exactly one place that
// shells out — always via execFile (argv array, no shell) and always with a
// hard timeout so a hung CLI process can never hang the poll loop forever.
async function runMultica(subArgs, timeoutMs) {
    try {
        const { stdout } = await execFileAsync(MIKA_CONFIG.cliPath, mikaCliArgs(subArgs), {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
        });
        return stdout;
    } catch (err) {
        // stderr/stdout from a failed CLI call can contain internal paths —
        // log server-side only, never let it reach an HTTP response.
        console.error('multica CLI call failed:', err.message);
        throw new Error('multica_cli_error');
    }
}

// Creates a child issue in the allowlisted project assigned to Mika, then
// re-fetches it to confirm it actually landed where it was asked to before
// the caller ever polls it for a reply.
// Multica's CLI rejects --description-file paths outside its own working
// directory (MUL-4252: stops a stale file from another run/environment being
// read by mistake), so this can't use os.tmpdir() (/tmp) -- the temp file has
// to live inside the app's own cwd instead, same directory runMultica's CLI
// invocation runs from.
const MIKA_TMP_DIR = path.join(__dirname, '.mika-tmp');

async function createMikaBridgeIssue(correlationId, adminMessage) {
    await fsp.mkdir(MIKA_TMP_DIR, { recursive: true });
    const tmpPath = path.join(MIKA_TMP_DIR, `mika-bridge-${correlationId}-${crypto.randomBytes(4).toString('hex')}.md`);
    await fsp.writeFile(tmpPath, adminMessage, 'utf8');
    try {
        const createOut = await runMultica([
            'issue', 'create',
            '--title', buildIssueTitle(correlationId),
            '--description-file', tmpPath,
            '--project', MIKA_CONFIG.projectId,
            '--parent', MIKA_CONFIG.parentIssueId,
            '--assignee-id', MIKA_CONFIG.agentId,
            '--status', 'todo',
            '--output', 'json',
        ], 20000);
        const created = JSON.parse(createOut);
        const issueId = created.id || created.issue?.id;
        if (!issueId) throw new Error('multica issue create returned no id');

        const verifyOut = await runMultica(['issue', 'get', issueId, '--output', 'json'], 15000);
        const issue = JSON.parse(verifyOut);
        if (
            issue.parent_issue_id !== MIKA_CONFIG.parentIssueId ||
            issue.assignee_id !== MIKA_CONFIG.agentId ||
            issue.project_id !== MIKA_CONFIG.projectId
        ) {
            throw new Error('created issue failed allowlist verification');
        }
        return issueId;
    } finally {
        fsp.unlink(tmpPath).catch(() => {});
    }
}

// Restart-recovery helpers (MYAG-156): a request already persisted with a
// multica_issue_id just needs re-verifying, not recreating. One without a
// persisted id yet might still have gotten as far as issue creation before
// the crash (createMikaBridgeIssue succeeded but the DB update after it
// didn't) -- search by title before creating a fresh one, so a restart never
// double-files the same admin message as two separate Mika issues.
async function verifyMikaBridgeIssue(issueId) {
    const verifyOut = await runMultica(['issue', 'get', issueId, '--output', 'json'], 15000);
    const issue = JSON.parse(verifyOut);
    if (
        issue.parent_issue_id !== MIKA_CONFIG.parentIssueId ||
        issue.assignee_id !== MIKA_CONFIG.agentId ||
        issue.project_id !== MIKA_CONFIG.projectId
    ) throw new Error('persisted issue failed allowlist verification');
    return issueId;
}

async function findExistingMikaBridgeIssue(correlationId) {
    const stdout = await runMultica(['issue', 'search', buildIssueTitle(correlationId), '--limit', '20', '--output', 'json'], 15000);
    const data = JSON.parse(stdout);
    const issues = Array.isArray(data) ? data : (data.issues || data.items || []);
    const exact = issues.find(issue => issue.title === buildIssueTitle(correlationId));
    return exact ? verifyMikaBridgeIssue(exact.id) : null;
}

const MIKA_POLL_INTERVAL_MS = 4000;
const MIKA_REPLY_TIMEOUT_MS = 90000;

// One poll attempt: lists the issue's top-level comments and returns Mika's
// reply text, or null if she hasn't answered yet.
async function pollMikaReplyOnce(issueId) {
    const stdout = await runMultica(['issue', 'comment', 'list', issueId, '--roots-only', '--output', 'json'], 15000);
    const data = JSON.parse(stdout);
    const comments = Array.isArray(data) ? data : (data.comments || data.items || []);
    return selectMikaReply(comments, { issueId, agentId: MIKA_CONFIG.agentId });
}

const MIKA_RATE_LIMIT = 5;
const MIKA_RATE_WINDOW = 10 * 60;
const MIKA_MESSAGE_MAX = 4000;
const MIKA_IDEMPOTENCY_WINDOW_SQL = "created_at > now() - interval '5 minutes'";

const ipLimitMika = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many messages to Mika from this IP. Please try again later.' },
});

// Drives one request end to end in the background: create the issue, poll
// for Mika's reply up to the timeout, persist the outcome, and push it to
// the admin's own connected sockets. Never touches the original res object —
// the HTTP handler has already responded by the time this runs.
async function processMikaRequest({ id, correlationId, message, adminUsername, issueId: persistedIssueId, createdAt }) {
    const deadline = createdAt
        ? new Date(createdAt).getTime() + MIKA_REPLY_TIMEOUT_MS
        : Date.now() + MIKA_REPLY_TIMEOUT_MS;
    try {
        let issueId = persistedIssueId
            ? await verifyMikaBridgeIssue(persistedIssueId)
            : await findExistingMikaBridgeIssue(correlationId);
        if (!issueId) issueId = await createMikaBridgeIssue(correlationId, message);
        if (!persistedIssueId) {
            await pgPool.query(
                'UPDATE mika_bridge_requests SET multica_issue_id = $1, updated_at = now() WHERE id = $2 AND multica_issue_id IS NULL',
                [issueId, id]
            );
        }

        let reply = null;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, MIKA_POLL_INTERVAL_MS));
            try {
                reply = await pollMikaReplyOnce(issueId);
            } catch (pollErr) {
                console.warn(`mika poll [${correlationId}] error (will retry):`, pollErr.message);
            }
            if (reply) break;
        }

        if (!reply) {
            await pgPool.query("UPDATE mika_bridge_requests SET status = 'timeout', updated_at = now() WHERE id = $1", [id]);
            await pushToUserSocket(adminUsername, 'mika_reply', {
                requestId: id, correlationId, status: 'timeout',
                error: "Mika is thinking — she didn't respond in time. Try again in a moment.",
            });
            return;
        }

        await pgPool.query(
            "UPDATE mika_bridge_requests SET status = 'completed', reply = $1, updated_at = now() WHERE id = $2",
            [reply, id]
        );
        await pushToUserSocket(adminUsername, 'mika_reply', { requestId: id, correlationId, status: 'completed', reply });
    } catch (err) {
        console.error(`mika bridge [${correlationId}] failed:`, err.message);
        await pgPool.query(
            "UPDATE mika_bridge_requests SET status = 'failed', error = 'internal_error', updated_at = now() WHERE id = $1",
            [id]
        ).catch(() => {});
        await pushToUserSocket(adminUsername, 'mika_reply', {
            requestId: id, correlationId, status: 'failed',
            error: 'Could not reach Mika right now. Please try again.',
        });
    }
}

// Runs once at boot, after the mika_bridge_requests table is ready. Any row
// still 'pending' from before a restart is either resumed (still within its
// timeout window) or marked 'timeout' — never left silently stuck forever.
async function recoverPendingMikaRequests() {
    if (!MIKA_CONFIGURED) return;
    try {
        const { rows } = await pgPool.query(
            "SELECT id, correlation_id, message, admin_username, multica_issue_id, created_at FROM mika_bridge_requests WHERE status = 'pending'"
        );
        for (const row of rows) {
            const age = Date.now() - new Date(row.created_at).getTime();
            if (age >= MIKA_REPLY_TIMEOUT_MS) {
                await pgPool.query("UPDATE mika_bridge_requests SET status = 'timeout', updated_at = now() WHERE id = $1", [row.id]);
                await pushToUserSocket(row.admin_username, 'mika_reply', {
                    requestId: row.id, correlationId: row.correlation_id, status: 'timeout',
                    error: "Mika is thinking — she didn't respond in time. Try again in a moment.",
                });
                continue;
            }
            console.log(`🌉 Resuming Mika bridge request ${row.correlation_id} after restart`);
            processMikaRequest({
                id: row.id, correlationId: row.correlation_id, message: row.message, adminUsername: row.admin_username,
                issueId: row.multica_issue_id, createdAt: row.created_at,
            }).catch(err => console.error(`mika bridge resume [${row.correlation_id}] failed:`, err.message));
        }
    } catch (err) {
        console.error('Mika bridge recovery failed:', err.message);
    }
}

app.post('/api/admin/mika/message', requireAuth, requireAdmin, ipLimitMika, async (req, res) => {
    if (!MIKA_CONFIGURED) {
        return res.status(503).json({ error: 'Mika bridge is not configured on this server.' });
    }

    const message = typeof (req.body || {}).message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'message is required.' });
    if (message.length > MIKA_MESSAGE_MAX) {
        return res.status(400).json({ error: `Message must be at most ${MIKA_MESSAGE_MAX} characters.` });
    }

    const withinLimit = await checkAndBumpRateLimit(
        `ratelimit:mika:${req.username}`, MIKA_RATE_LIMIT, MIKA_RATE_WINDOW
    );
    if (!withinLimit) {
        return res.status(429).json({ error: 'Too many messages to Mika. Please slow down.' });
    }

    try {
        const contentHash = computeContentHash(req.username, message);

        // 5-minute idempotency window: an identical message from the same
        // admin reuses the existing request instead of creating a new issue.
        const existing = await pgPool.query(
            `SELECT id, correlation_id, status, reply FROM mika_bridge_requests
             WHERE admin_username = $1 AND content_hash = $2 AND ${MIKA_IDEMPOTENCY_WINDOW_SQL}
             ORDER BY created_at DESC LIMIT 1`,
            [req.username, contentHash]
        );
        if (existing.rows.length) {
            const row = existing.rows[0];
            if (row.status === 'completed') {
                logAnalyticsEvent('mika_message_dedup', req.username);
                return res.json({ requestId: row.id, correlationId: row.correlation_id, status: 'completed', reply: row.reply, cached: true });
            }
            if (row.status === 'pending') {
                return res.status(202).json({ requestId: row.id, correlationId: row.correlation_id, status: 'pending', cached: true });
            }
            // status is 'timeout' or 'failed' — fall through and let the admin retry fresh.
        }

        const id = crypto.randomUUID();
        const correlationId = crypto.randomBytes(4).toString('hex').toUpperCase();
        await pgPool.query(
            `INSERT INTO mika_bridge_requests (id, admin_username, content_hash, correlation_id, message, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [id, req.username, contentHash, correlationId, message]
        );
        logAnalyticsEvent('mika_message_sent', req.username);
        res.status(202).json({ requestId: id, correlationId, status: 'pending' });

        processMikaRequest({ id, correlationId, message, adminUsername: req.username })
            .catch(err => console.error(`mika bridge [${correlationId}] unhandled:`, err.message));
    } catch (err) {
        console.error('mika/message failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Lets the admin UI restore request/reply history across refresh/reconnect
// instead of relying solely on the live Socket.IO push.
app.get('/api/admin/mika/requests', requireAuth, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
        const result = await pgPool.query(
            `SELECT id, correlation_id, message, status, reply, error, created_at, updated_at
             FROM mika_bridge_requests WHERE admin_username = $1 ORDER BY created_at DESC LIMIT $2`,
            [req.username, limit]
        );
        res.json({
            requests: result.rows.map(r => ({
                requestId: r.id,
                correlationId: r.correlation_id,
                message: r.message,
                status: r.status,
                reply: r.reply,
                error: r.error,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            })),
        });
    } catch (err) {
        console.error('mika/requests failed:', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Map user to socket ID and store their public key string inside Redis.
    // The token is the only source of truth for identity here — a client claiming
    // any other username without a matching valid JWT is rejected outright.
    // Auth order: httpOnly cookie from the handshake HTTP request first (set by
    // login/signup), then data.token as a fallback during the frontend transition.
    socket.on('register_user', async (data) => {
        let decoded;
        try {
            const cookieHeader = socket.handshake.headers.cookie || '';
            const cookieMatch = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
            const cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
            const token = cookieToken || (data || {}).token;
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (err) {
            socket.emit('auth_error', { error: 'Session expired or invalid. Please log in again.' });
            socket.disconnect(true);
            return;
        }

        socket.username = decoded.username;
        data = { ...data, username: decoded.username };
        // Use the stable per-browser deviceId the client generated (MYAG-80); fall
        // back to socket.id for old clients that don't send one yet.
        const deviceId = (typeof data.deviceId === 'string' && data.deviceId) ? data.deviceId : socket.id;
        socket.deviceId = deviceId;
        await redisClient.hSet(`user:${data.username}:sockets`, deviceId, socket.id);
        if (data.publicKey) await redisClient.hSet(`user:${data.username}:pubkeys`, deviceId, data.publicKey);

        // Cache this user's last-seen privacy preference in Redis so the hot presence
        // paths below (and get_user_public_key/disconnect) never need a Postgres round trip.
        let lastSeenVisible = true;
        try {
            const userRow = await pgPool.query('SELECT last_seen_visible FROM users WHERE username = $1', [data.username]);
            if (userRow.rows.length) lastSeenVisible = userRow.rows[0].last_seen_visible;
        } catch (err) {
            console.error('Failed to load last_seen_visible:', err.message);
        }
        await redisClient.set(`user:${data.username}:lastSeenVisible`, lastSeenVisible ? 'true' : 'false');

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
            lastSeen: lastSeenVisible ? Date.now() : null
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
            } else if (payload.kind === 'status_delete') {
                socket.emit('status_deleted', payload);
            } else if (payload.kind === 'read_receipt') {
                socket.emit('message_status_update', { id: payload.id, peer: payload.peer, status: payload.status });
            } else if (payload.kind === 'group_message') {
                socket.emit('receive_group_message', payload);
            } else if (payload.kind === 'group_edit') {
                socket.emit('group_message_edited', payload);
            } else if (payload.kind === 'group_delete') {
                socket.emit('group_message_deleted_everyone', payload);
            } else if (payload.kind === 'group_reaction') {
                socket.emit('group_message_reacted', payload);
            } else if (payload.kind === 'group_read_receipt') {
                socket.emit('group_message_status_update', { groupId: payload.groupId, id: payload.id, reader: payload.reader });
            } else {
                // Fan-out format: slice the reconnecting device's encrypted key from the stored map.
                if (payload.deviceCiphertexts && typeof payload.deviceCiphertexts === 'object') {
                    const encryptedKey = socket.deviceId ? (payload.deviceCiphertexts[socket.deviceId] || null) : null;
                    const { deviceCiphertexts, ...rest } = payload;
                    socket.emit('receive_private_message', { ...rest, encryptedKey });
                } else {
                    socket.emit('receive_private_message', payload);
                }
                for (const sid of await getUserSockets(payload.sender)) {
                    io.to(sid).emit('message_status_update', { id: payload.id, peer: data.username, status: 'delivered' });
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
    // Returns the first registered device key for backward-compat with old clients.
    // Use get_peer_devices to get all per-device keys for fan-out encryption.
    socket.on('get_user_public_key', async (username, callback) => {
        const pubKeys = await redisClient.hVals(`user:${username}:pubkeys`);
        const pubKey = pubKeys[0] || null;
        
        // 🌟 TARGETED STATUS CHECK: Fetch their real-time state flags out of Redis directly
        const isOnlineStr = await redisClient.get(`user:${username}:online`);
        const lastSeenStr = await redisClient.get(`user:${username}:lastSeen`);
        const lastSeenVisibleStr = await redisClient.get(`user:${username}:lastSeenVisible`);

        const online = isOnlineStr === 'true';
        const lastSeenVisible = lastSeenVisibleStr !== 'false'; // default to visible if never cached
        const lastSeen = lastSeenVisible ? (lastSeenStr ? parseInt(lastSeenStr, 10) : Date.now()) : null;

        // Send a complete picture back to the requesting tab workspace
        callback(pubKey, { online, lastSeen });
    });

    // Returns the calling user's own registered devices: [{deviceId, publicKey}].
    // Used by the frontend device-cache and fan-out encryption logic. Only the
    // authenticated user may list their own devices — no cross-user lookup.
    socket.on('get_device_list', async (callback) => {
        if (!socket.username || typeof callback !== 'function') return;
        try {
            const entries = await redisClient.hGetAll(`user:${socket.username}:pubkeys`);
            const devices = Object.entries(entries).map(([deviceId, publicKey]) => ({ deviceId, publicKey }));
            callback({ devices });
        } catch (err) {
            console.error('get_device_list failed:', err.message);
            callback({ devices: [] });
        }
    });

    // Returns all registered devices [{deviceId, publicKey}] for any user the caller
    // is friends with (or for themselves). Used by the sender to build the per-device
    // ciphertext map before calling send_private_message with the fan-out format.
    socket.on('get_peer_devices', async (targetUsername, callback) => {
        if (!socket.username || typeof callback !== 'function') return;
        if (typeof targetUsername !== 'string' || !targetUsername) return callback({ devices: [] });
        try {
            // Self-lookup always allowed; cross-user lookup requires friendship.
            if (targetUsername !== socket.username) {
                const ok = await areFriends(socket.username, targetUsername);
                if (!ok) return callback({ devices: [] });
            }
            const entries = await redisClient.hGetAll(`user:${targetUsername}:pubkeys`);
            const devices = Object.entries(entries).map(([deviceId, publicKey]) => ({ deviceId, publicKey }));
            callback({ devices });
        } catch (err) {
            console.error('get_peer_devices failed:', err.message);
            callback({ devices: [] });
        }
    });

    // Route a locked payload to a specific socket ID destination.
    //
    // Fan-out (multi-device) format — preferred:
    //   data.encryptedContent   — AES-GCM ciphertext of the message body (base64)
    //   data.deviceCiphertexts  — { [deviceId]: RSA-OAEP-encrypted AES key (base64) }
    //                             includes entries for every recipient device AND the
    //                             sender's own other devices (so they sync the message).
    //
    // Legacy single-device format — still accepted for backward compatibility:
    //   data.encryptedMessage   — single RSA-OAEP+AES-GCM envelope (base64)
    socket.on('send_private_message', async (data) => {
        if (!data.targetUsername) return;

        // Messaging (including Status broadcasts) requires an accepted friend request —
        // enforced here, not just hidden in the UI, so a modified client can't bypass it.
        const friends = await areFriends(socket.username, data.targetUsername);
        if (!friends) {
            socket.emit('message_blocked', { targetUsername: data.targetUsername, reason: 'not_friends' });
            logAnalyticsEvent('message_blocked', socket.username);
            return;
        }

        const isFanOut = data.deviceCiphertexts && typeof data.deviceCiphertexts === 'object';

        const basePayload = {
            kind: 'message',
            id: data.id,
            sender: socket.username,
            replyToText: data.replyToText || null,
            replyToId: data.replyToId || null,
            forwarded: !!data.forwarded,
            broadcast: !!data.broadcast,
            status: !!data.status
        };

        if (isFanOut) {
            // Per-device relay: pick the encrypted key that matches each socket's deviceId.
            const emitToSockets = async (sids) => {
                for (const sid of sids) {
                    const targetSocket = io.sockets.sockets.get(sid);
                    const deviceId = targetSocket?.deviceId || null;
                    const encryptedKey = deviceId ? (data.deviceCiphertexts[deviceId] || null) : null;
                    io.to(sid).emit('receive_private_message', {
                        ...basePayload,
                        encryptedContent: data.encryptedContent,
                        encryptedKey
                    });
                }
            };

            const targetSockets = await getUserSockets(data.targetUsername);
            if (targetSockets.length) {
                await emitToSockets(targetSockets);
                socket.emit('message_status_update', { id: data.id, peer: data.targetUsername, status: 'delivered' });
                console.log(`📬 Fan-out message routed from ${socket.username} to ${data.targetUsername}`);
            } else {
                // Store the full ciphertext map; reconnecting device slices its own key.
                await queueForOfflineUser(data.targetUsername, {
                    ...basePayload,
                    encryptedContent: data.encryptedContent,
                    deviceCiphertexts: data.deviceCiphertexts
                });
                console.log(`📥 ${data.targetUsername} is offline — fan-out message queued`);
            }

            // Sync the message to sender's own other connected devices.
            const senderSockets = await getUserSockets(socket.username);
            const otherSenderSids = senderSockets.filter(sid => sid !== socket.id);
            if (otherSenderSids.length) await emitToSockets(otherSenderSids);

        } else {
            // Legacy path: relay the single encryptedMessage envelope as-is.
            const payload = { ...basePayload, encryptedMessage: data.encryptedMessage };
            const targetSockets = await getUserSockets(data.targetUsername);
            if (targetSockets.length) {
                for (const sid of targetSockets) io.to(sid).emit('receive_private_message', payload);
                socket.emit('message_status_update', { id: data.id, peer: data.targetUsername, status: 'delivered' });
                console.log(`📬 Message successfully routed from ${socket.username} to ${data.targetUsername}`);
            } else {
                await queueForOfflineUser(data.targetUsername, payload);
                console.log(`📥 ${data.targetUsername} is offline — message queued for delivery`);
            }
        }

        if (!data.status) {
            logAnalyticsEvent('message_sent', socket.username); // exclude Status broadcasts, which piggyback on this same relay
            // attachmentType is optional unencrypted metadata the client may send alongside the ciphertext
            const at = data.attachmentType;
            if (at === 'audio') logAnalyticsEvent('voice_note_sent', socket.username);
            else if (at === 'image') logAnalyticsEvent('photo_sent', socket.username);
            else if (at === 'document') logAnalyticsEvent('document_sent', socket.username);
        }
    });

    // Edit a previously-sent text message — same online/offline pattern as send_private_message
    socket.on('edit_message', async (data) => {
        if (!data.id || !data.targetUsername || !data.encryptedMessage) return;
        const targetSockets = await getUserSockets(data.targetUsername);
        const payload = { kind: 'edit', id: data.id, sender: socket.username, encryptedMessage: data.encryptedMessage };

        if (targetSockets.length) {
            for (const sid of targetSockets) io.to(sid).emit('message_edited', payload);
        } else {
            await queueForOfflineUser(data.targetUsername, payload);
        }
    });

    // Delete a message for both participants — same online/offline pattern
    socket.on('delete_message_everyone', async (data) => {
        if (!data.id || !data.targetUsername) return;
        const targetSockets = await getUserSockets(data.targetUsername);
        const payload = { kind: 'delete', id: data.id, sender: socket.username };

        if (targetSockets.length) {
            for (const sid of targetSockets) io.to(sid).emit('message_deleted_everyone', payload);
        } else {
            await queueForOfflineUser(data.targetUsername, payload);
        }
    });

    // React to a message with an emoji (or clear a reaction with emoji: null) —
    // same online/offline pattern as edit_message
    socket.on('react_message', async (data) => {
        if (!data.id || !data.targetUsername) return;
        const targetSockets = await getUserSockets(data.targetUsername);
        const payload = { kind: 'reaction', id: data.id, sender: socket.username, emoji: data.emoji || null };

        if (targetSockets.length) {
            for (const sid of targetSockets) io.to(sid).emit('message_reacted', payload);
        } else {
            await queueForOfflineUser(data.targetUsername, payload);
        }
    });

    // Deleting your own Status removes it from every current friend's device too --
    // same fan-out-to-every-friend delivery as posting one (see send_private_message
    // callers on the client), just a delete instead of content, and same
    // online/offline-queue pattern as everything else here.
    socket.on('delete_status', async (data) => {
        if (!data.statusId) return;
        try {
            const friendRows = await pgPool.query(
                'SELECT user_a, user_b FROM friendships WHERE user_a = $1 OR user_b = $1',
                [socket.username]
            );
            const payload = { kind: 'status_delete', id: data.statusId, sender: socket.username };
            for (const row of friendRows.rows) {
                const target = row.user_a === socket.username ? row.user_b : row.user_a;
                const targetSockets = await getUserSockets(target);
                if (targetSockets.length) {
                    for (const sid of targetSockets) io.to(sid).emit('status_deleted', payload);
                } else {
                    await queueForOfflineUser(target, payload);
                }
            }
        } catch (err) {
            console.error('delete_status failed:', err.message);
        }
    });

    /* GROUP MESSAGING — the client pre-encrypts the same content separately for
       each current member's public key (see encryptPayloadForUser calls in the
       browser) and sends all of those ciphertexts in one shot as `recipients`; this
       handler's only job is fan-out delivery to each named member, live or queued,
       exactly like send_private_message does for a single recipient. The server
       never sees plaintext and never stores the message itself, same as 1:1. */
    socket.on('send_group_message', async (data) => {
        if (!data.groupId || !data.id || !data.recipients || typeof data.recipients !== 'object') return;
        const role = await getGroupRole(data.groupId, socket.username);
        if (!role) return; // not a member -- silently drop, same posture as message_blocked below but nothing to notify
        const group = await getGroupOrNull(data.groupId);
        if (!group) return;
        if (group.only_admins_can_send && role !== 'admin') {
            socket.emit('group_message_blocked', { groupId: data.groupId, reason: 'admins_only' });
            return;
        }

        for (const [targetUsername, encryptedMessage] of Object.entries(data.recipients)) {
            if (targetUsername === socket.username) continue;
            const payload = {
                kind: 'group_message',
                groupId: data.groupId,
                id: data.id,
                sender: socket.username,
                encryptedMessage,
                replyToText: (data.replyRecipients && data.replyRecipients[targetUsername]) || null,
                replyToId: data.replyToId || null
            };
            const targetSockets = await getUserSockets(targetUsername);
            if (targetSockets.length) {
                for (const sid of targetSockets) io.to(sid).emit('receive_group_message', payload);
            } else {
                await queueForOfflineUser(targetUsername, payload);
            }
        }
        logAnalyticsEvent('group_message_sent', socket.username);
        const gat = data.attachmentType;
        if (gat === 'audio') logAnalyticsEvent('voice_note_sent', socket.username);
        else if (gat === 'image') logAnalyticsEvent('photo_sent', socket.username);
        else if (gat === 'document') logAnalyticsEvent('document_sent', socket.username);
    });

    socket.on('edit_group_message', async (data) => {
        if (!data.groupId || !data.id || !data.recipients) return;
        const role = await getGroupRole(data.groupId, socket.username);
        if (!role) return;

        for (const [targetUsername, encryptedMessage] of Object.entries(data.recipients)) {
            if (targetUsername === socket.username) continue;
            const payload = { kind: 'group_edit', groupId: data.groupId, id: data.id, sender: socket.username, encryptedMessage };
            const targetSockets = await getUserSockets(targetUsername);
            if (targetSockets.length) for (const sid of targetSockets) io.to(sid).emit('group_message_edited', payload);
            else await queueForOfflineUser(targetUsername, payload);
        }
    });

    socket.on('delete_group_message_everyone', async (data) => {
        if (!data.groupId || !data.id) return;
        const role = await getGroupRole(data.groupId, socket.username);
        if (!role) return;

        const members = await getGroupMembers(data.groupId);
        const payload = { kind: 'group_delete', groupId: data.groupId, id: data.id, sender: socket.username };
        for (const m of members) {
            if (m.username === socket.username) continue;
            const targetSockets = await getUserSockets(m.username);
            if (targetSockets.length) for (const sid of targetSockets) io.to(sid).emit('group_message_deleted_everyone', payload);
            else await queueForOfflineUser(m.username, payload);
        }
    });

    socket.on('react_group_message', async (data) => {
        if (!data.groupId || !data.id) return;
        const role = await getGroupRole(data.groupId, socket.username);
        if (!role) return;

        const members = await getGroupMembers(data.groupId);
        const payload = { kind: 'group_reaction', groupId: data.groupId, id: data.id, sender: socket.username, emoji: data.emoji || null };
        for (const m of members) {
            if (m.username === socket.username) continue;
            const targetSockets = await getUserSockets(m.username);
            if (targetSockets.length) for (const sid of targetSockets) io.to(sid).emit('group_message_reacted', payload);
            else await queueForOfflineUser(m.username, payload);
        }
    });

    // Aggregate read receipts: the reader already knows who sent each message
    // (their own local history), so it tells each original sender directly rather
    // than the server tracking per-message senders itself.
    socket.on('mark_group_message_read', async (data) => {
        if (!data.groupId || !Array.isArray(data.reads)) return;
        const role = await getGroupRole(data.groupId, socket.username);
        if (!role) return;

        for (const { id, sender } of data.reads) {
            if (!id || !sender || sender === socket.username) continue;
            const payload = { groupId: data.groupId, id, reader: socket.username };
            const senderSockets = await getUserSockets(sender);
            if (senderSockets.length) {
                for (const sid of senderSockets) io.to(sid).emit('group_message_status_update', payload);
            } else {
                await queueForOfflineUser(sender, { kind: 'group_read_receipt', ...payload });
            }
        }
    });

    // Typing indicators, ephemeral like the 1:1 versions -- relay live to every
    // other member currently online, never queued.
    socket.on('group_typing_start', async (data) => {
        if (!data.groupId) return;
        const members = await getGroupMembers(data.groupId);
        for (const m of members) {
            if (m.username === socket.username) continue;
            for (const sid of await getUserSockets(m.username)) io.to(sid).emit('group_typing_start', { groupId: data.groupId, sender: socket.username });
        }
    });
    socket.on('group_typing_stop', async (data) => {
        if (!data.groupId) return;
        const members = await getGroupMembers(data.groupId);
        for (const m of members) {
            if (m.username === socket.username) continue;
            for (const sid of await getUserSockets(m.username)) io.to(sid).emit('group_typing_stop', { groupId: data.groupId, sender: socket.username });
        }
    });

    // In-chat mini-games (invite/accept/move/reset/leave) are relayed live only,
    // just like typing indicators — never queued, since a stale move replayed after
    // the recipient comes back online minutes later wouldn't make sense.
    socket.on('game_event', async (data) => {
        if (!data.targetUsername || !data.gameType || !data.payload) return;
        for (const sid of await getUserSockets(data.targetUsername)) {
            io.to(sid).emit('game_event', { sender: socket.username, gameType: data.gameType, payload: data.payload });
        }
        // Only whitelist-validated game types to keep event_type bounded to safe values.
        // 'accept' = guest accepted the invite = game genuinely begins; 'leave' = game ended.
        const VALID_GAME_TYPES = ['tictactoe', 'rps', 'truthdare', 'connect4', 'wordchain', 'hangman', 'wyr', 'twentyq', 'emojicharades', 'trivia', 'dotsboxes'];
        if (VALID_GAME_TYPES.includes(data.gameType)) {
            if (data.payload.action === 'accept') logAnalyticsEvent(`game_${data.gameType}_started`, socket.username);
            else if (data.payload.action === 'leave') logAnalyticsEvent(`game_${data.gameType}_completed`, socket.username);
        }
    });

    // PROFILE — profile data (about/interests/avatar/etc.) lives only on-device,
    // encrypted at rest there, never on this server. To let a viewer see it, the
    // server just relays a live request/response between the two sockets: the
    // viewer asks, the profile owner's own client computes what that specific
    // viewer is allowed to see (their per-field visibility rules) and sends back
    // only that filtered subset. If the owner isn't online right now there's
    // nothing to relay to, so the viewer is told immediately instead of hanging.
    socket.on('request_profile', async (data) => {
        if (!data || !data.targetUsername || !data.requestId) return;
        const targetSockets = await getUserSockets(data.targetUsername);
        if (!targetSockets.length) {
            socket.emit('profile_response', { requestId: data.requestId, fromUsername: data.targetUsername, online: false, profile: null });
            return;
        }
        for (const sid of targetSockets) io.to(sid).emit('profile_requested', { requesterUsername: socket.username, requestId: data.requestId });
    });

    socket.on('submit_profile_response', async (data) => {
        if (!data || !data.requesterUsername || !data.requestId) return;
        for (const sid of await getUserSockets(data.requesterUsername)) {
            io.to(sid).emit('profile_response', {
                requestId: data.requestId,
                fromUsername: socket.username,
                online: true,
                profile: data.profile || null
            });
        }
    });

    // NEARBY — anonymous, 24h-expiring matches with whoever else is online right now.
    // All handlers below relay live only (never queued), same rule as typing/game
    // events: a match only exists between two people who were just online together.
    // Reported by the client when the Nearby tab is opened (after the browser's
    // geolocation permission prompt) — coarse, short-lived, and never sent to other
    // clients directly, only used server-side to compute distance for filtering.
    socket.on('nearby_update_location', async (data) => {
        const me = socket.username;
        if (!me || !data || typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
        await redisClient.set(`user:${me}:geo`, JSON.stringify({ lat: data.lat, lng: data.lng }), { EX: NEARBY_GEO_TTL });
    });

    socket.on('nearby_get_online_list', async (data, callback) => {
        if (typeof callback !== 'function') return;
        const me = socket.username;
        if (!me) return callback([]);
        if (!data || typeof data.lat !== 'number' || typeof data.lng !== 'number') return callback([]);

        const onlineUsers = await redisClient.sMembers('online_users');
        const activePeers = await getActiveNearbyPeers(me);
        const candidates = onlineUsers.filter(u => u !== me && !activePeers.has(u));

        const list = [];
        for (const target of candidates) {
            const rawGeo = await redisClient.get(`user:${target}:geo`);
            if (!rawGeo) continue; // hasn't opened Nearby / shared location recently — can't be placed within radius
            const geo = JSON.parse(rawGeo);
            const distance = haversineMiles(data.lat, data.lng, geo.lat, geo.lng);
            if (distance > NEARBY_RADIUS_MILES) continue;

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

        const targetSockets = await getUserSockets(targetUsername);
        if (!targetSockets.length) return callback({ error: 'That person just went offline.' });

        const aliasOfMeForTarget = await getOrCreateNearbyAlias(targetUsername, me);
        const requestId = crypto.randomUUID();

        await redisClient.set(`nearby:request:${requestId}`, JSON.stringify({
            from: me,
            to: targetUsername,
            fromEphemeralPubKey: data.myEphemeralPubKey
        }), { EX: 60 * 10 }); // 10 minutes to respond before the request goes stale

        for (const sid of targetSockets) io.to(sid).emit('nearby_request_received', {
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

        const requesterSockets = await getUserSockets(request.from);

        if (!data.accept) {
            for (const sid of requesterSockets) io.to(sid).emit('nearby_request_declined', { requestId: data.requestId });
            return callback({ ok: true });
        }
        if (!data.myEphemeralPubKey) return callback({ error: 'Missing key material.' });
        if (!requesterSockets.length) return callback({ error: 'They went offline before you accepted.' });

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
        logAnalyticsEvent('nearby_match_created', me);

        // requestId is required on both emits — the client correlates this event back to
        // the ephemeral keypair it generated when it sent/accepted the request via
        // pendingNearbyRequests[requestId]. Omitting it (as this did originally) means
        // the match is created fine server-side but silently never appears on either
        // client, since the lookup on data.requestId always misses.
        for (const sid of requesterSockets) io.to(sid).emit('nearby_match_created', {
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
        const otherSockets = await getUserSockets(otherUser);
        for (const sid of otherSockets) io.to(sid).emit('nearby_message_received', { matchId: data.matchId, encryptedMessage: data.encryptedMessage });
        callback({ ok: true, delivered: otherSockets.length > 0 });
    });

    // Typing indicators are ephemeral — relay only if the recipient is online right now,
    // never queued, since a "was typing" notice minutes later is meaningless.
    socket.on('typing_start', async (data) => {
        if (!data.targetUsername) return;
        for (const sid of await getUserSockets(data.targetUsername)) io.to(sid).emit('typing_start', { sender: socket.username });
    });
    socket.on('typing_stop', async (data) => {
        if (!data.targetUsername) return;
        for (const sid of await getUserSockets(data.targetUsername)) io.to(sid).emit('typing_stop', { sender: socket.username });
    });

    /* VOICE CALLING — signaling (MYAG-218-BE). Audio itself never touches this server
       (P2P or via the TURN relay from MYAG-218-DEVOPS) -- only offer/answer/ICE
       envelopes and call-state transitions pass through here, and only between the
       two participants callManager already knows are on a given callId; a client
       can't inject signaling into a call it isn't part of. */
    socket.on('call:invite', async (data, callback) => {
        if (typeof callback !== 'function') callback = () => {};
        if (!socket.username) return callback({ ok: false, reason: 'not_authenticated' });
        const targetUsername = data && data.targetUsername;
        if (typeof targetUsername !== 'string' || !targetUsername) return callback({ ok: false, reason: 'invalid_target' });
        try {
            const result = await callManager.inviteCall(socket.username, targetUsername);
            if (!result.ok) return callback(result);
            for (const sid of await getUserSockets(targetUsername)) {
                io.to(sid).emit('call:invite', { callId: result.call.callId, caller: socket.username });
            }
            logAnalyticsEvent('call_invited', socket.username);
            callback({ ok: true, callId: result.call.callId });
        } catch (err) {
            console.error('call:invite failed:', err.message);
            callback({ ok: false, reason: 'error' });
        }
    });

    socket.on('call:accept', async (data) => {
        if (!socket.username || !data || !data.callId) return;
        const result = callManager.acceptCall(data.callId, socket.username);
        if (!result.ok) return;
        for (const sid of await getUserSockets(result.call.caller)) io.to(sid).emit('call:accepted', { callId: result.call.callId });
        logAnalyticsEvent('call_accepted', socket.username);
    });

    socket.on('call:decline', async (data) => {
        if (!socket.username || !data || !data.callId) return;
        const result = callManager.declineCall(data.callId, socket.username);
        if (!result.ok) return;
        for (const sid of await getUserSockets(result.call.caller)) io.to(sid).emit('call:declined', { callId: result.call.callId });
        logAnalyticsEvent('call_declined', socket.username);
    });

    socket.on('call:end', async (data) => {
        if (!socket.username || !data || !data.callId) return;
        const result = callManager.endCall(data.callId, socket.username);
        if (!result.ok) return;
        const target = otherParty(result.call, socket.username);
        for (const sid of await getUserSockets(target)) io.to(sid).emit('call:ended', { callId: result.call.callId, status: result.call.status });
        logAnalyticsEvent('call_ended', socket.username);
    });

    // Offer/answer/ICE all share the same shape of guard: the callId must be a call
    // this socket's user is actually part of, and it's relayed only to the other
    // participant -- never to whatever target a client might claim.
    function relayToCallPeer(event) {
        return async (data) => {
            if (!socket.username || !data || !data.callId) return;
            const call = callManager.getCall(data.callId);
            const target = otherParty(call, socket.username);
            if (!target) return;
            const { callId, sdp, candidate } = data;
            for (const sid of await getUserSockets(target)) io.to(sid).emit(event, { callId, sdp, candidate });
        };
    }
    socket.on('call:offer', relayToCallPeer('call:offer'));
    socket.on('call:answer', relayToCallPeer('call:answer'));
    socket.on('call:ice-candidate', relayToCallPeer('call:ice-candidate'));

    // Relay read receipts back to the original sender -- same online/offline-queue
    // pattern as messages/edits/deletes/reactions below. Previously this only ever
    // reached the sender if they happened to be online at the exact moment the
    // reader opened the chat; if they were offline, the fact that their message had
    // already been read was silently dropped and never resurfaced, even after they
    // reconnected. Queuing it means "already read" is durable, not a live-only signal.
    socket.on('mark_message_read', async (data) => {
        if (!data.peer || !Array.isArray(data.messageIds)) return;
        const originalSenderSockets = await getUserSockets(data.peer);
        if (originalSenderSockets.length) {
            data.messageIds.forEach(id => {
                for (const sid of originalSenderSockets) io.to(sid).emit('message_status_update', { id, peer: socket.username, status: 'read' });
            });
        } else {
            for (const id of data.messageIds) {
                await queueForOfflineUser(data.peer, { kind: 'read_receipt', id, peer: socket.username, status: 'read' });
            }
        }
    });

    // Handle session termination cleanups
    socket.on('disconnect', async () => {
        if (socket.username) {
            // Remove only this device's entries; other devices stay connected.
            const dId = socket.deviceId || socket.id;
            await redisClient.hDel(`user:${socket.username}:sockets`, dId);
            await redisClient.hDel(`user:${socket.username}:pubkeys`, dId);

            const remainingSockets = await redisClient.hLen(`user:${socket.username}:sockets`);
            if (remainingSockets === 0) {
                // Last device disconnected — mark user fully offline.
                const now = Date.now();
                await redisClient.set(`user:${socket.username}:online`, 'false');
                await redisClient.set(`user:${socket.username}:lastSeen`, now.toString());
                await redisClient.sRem('online_users', socket.username);

                const lastSeenVisibleStr = await redisClient.get(`user:${socket.username}:lastSeenVisible`);
                const lastSeenVisible = lastSeenVisibleStr !== 'false';

                io.emit('presence_broadcast_update', {
                    username: socket.username,
                    online: false,
                    lastSeen: lastSeenVisible ? now : null
                });

                // Last device gone: don't strand whoever's on the other end of a call
                // with this user -- end it now rather than leaving them ringing/active
                // against someone who's no longer reachable.
                const endedCall = callManager.handleUserDisconnected(socket.username);
                if (endedCall) {
                    const target = otherParty(endedCall, socket.username);
                    for (const sid of await getUserSockets(target)) {
                        io.to(sid).emit('call:ended', { callId: endedCall.callId, status: endedCall.status });
                    }
                }
            }

            console.log(`🏃 User ${socket.username} has disconnected (${remainingSockets} device(s) still online).`);
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 HAI server on port ${PORT}`));
