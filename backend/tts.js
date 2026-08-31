'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_SPEED_BY_EMOTION = Object.freeze({
    happy: 1.03,
    excited: 1.05,
    calm: 0.94,
    curious: 1.00,
    concerned: 0.93,
    sad: 0.90,
    neutral: 0.98,
});

const VOICE_PROFILE_BY_EMOTION = Object.freeze({
    happy: 'warm',
    excited: 'warm',
    calm: 'neutral',
    curious: 'neutral',
    concerned: 'gentle',
    sad: 'gentle',
    neutral: 'neutral',
});

function voiceProfileForEmotion(emotion) {
    const normalized = String(emotion || 'neutral').trim().toLowerCase();
    return VOICE_PROFILE_BY_EMOTION[normalized] || VOICE_PROFILE_BY_EMOTION.neutral;
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function createFixedWindowLimiter(limit, windowMs, now = Date.now) {
    const buckets = new Map();
    return {
        consume(key) {
            const current = now();
            const safeKey = String(key || 'unknown');
            let bucket = buckets.get(safeKey);
            if (!bucket || current >= bucket.resetAt) {
                bucket = { count: 0, resetAt: current + windowMs };
                buckets.set(safeKey, bucket);
            }
            if (bucket.count >= limit) return false;
            bucket.count += 1;
            if (buckets.size > 1000) {
                for (const [bucketKey, candidate] of buckets) {
                    if (current >= candidate.resetAt) buckets.delete(bucketKey);
                }
            }
            return true;
        },
    };
}

function createNaturalSpeechChunker({ minChars = 120, maxChars = 300 } = {}) {
    let pending = '';
    function takeBoundary(force = false) {
        const chunks = [];
        while (pending) {
            let boundary = -1;
            const sentencePattern = /[.!?](?:["')])*\s+/g;
            let match;
            while ((match = sentencePattern.exec(pending))) {
                const candidate = match.index + match[0].length;
                if (candidate >= minChars || force) {
                    boundary = candidate;
                    break;
                }
            }
            if (boundary < 0 && pending.length >= maxChars) {
                const search = pending.slice(0, maxChars + 1);
                const clause = Math.max(search.lastIndexOf(', '), search.lastIndexOf('; '), search.lastIndexOf(': '));
                const word = search.lastIndexOf(' ');
                boundary = clause >= minChars ? clause + 2 : (word >= minChars ? word + 1 : maxChars);
            }
            if (boundary < 0 && force) boundary = pending.length;
            if (boundary < 0) break;
            const chunk = pending.slice(0, boundary);
            pending = pending.slice(boundary);
            if (chunk.trim()) chunks.push(chunk);
        }
        return chunks;
    }
    return { push(text) { pending += text || ''; return takeBoundary(false); }, flush() { return takeBoundary(true); } };
}

function prepareTextForSpeech(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .replace(/\.{2,}/g, ',')
        .replace(/!{2,}/g, '!')
        .replace(/\?{2,}/g, '?')
        .replace(/([,;:])\1+/g, '$1')
        .replace(/,([!?])/g, '$1')
        .trim();
}

function createKokoroProvider(options) {
    const { baseUrl, voices, model, responseFormat, baseSpeed, timeoutMs, maxAudioBytes, fetchImpl } = options;
    return {
        name: 'kokoro',
        async synthesize(text, { emotion = 'neutral' } = {}) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const emotionSpeed = DEFAULT_SPEED_BY_EMOTION[emotion] || DEFAULT_SPEED_BY_EMOTION.neutral;
                const speed = clampNumber(baseSpeed * emotionSpeed, 0.98, 0.75, 1.25);
                const profile = voiceProfileForEmotion(emotion);
                const voice = voices[profile] || voices.neutral;
                const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, input: prepareTextForSpeech(text), voice, response_format: responseFormat, speed: Number(speed.toFixed(3)) }),
                    signal: controller.signal,
                });
                if (!response.ok) throw new Error(`Kokoro responded ${response.status}`);
                const buffer = Buffer.from(await response.arrayBuffer());
                if (!buffer.length) throw new Error('Kokoro returned empty audio');
                if (buffer.length > maxAudioBytes) throw new Error('Kokoro audio exceeded the configured size limit');
                return { buffer, extension: responseFormat === 'wav' ? 'wav' : 'mp3', mimeType: responseFormat === 'wav' ? 'audio/wav' : 'audio/mpeg', provider: 'kokoro', voice, profile };
            } finally { clearTimeout(timer); }
        },
    };
}

function createTtsService({ env = process.env, fetchImpl = global.fetch, now = Date.now } = {}) {
    const providerName = String(env.TTS_PROVIDER || 'kokoro').toLowerCase();
    const storageDir = env.TTS_STORAGE_DIR || path.join(__dirname, 'tts-audio');
    const maxChars = Math.round(clampNumber(env.H_TTS_MAX_CHARS, 1200, 100, 4000));
    const requestsPerMinute = Math.round(clampNumber(env.H_TTS_MAX_PER_MINUTE, 10, 1, 120));
    const ttlMs = clampNumber(env.H_TTS_AUDIO_TTL_HOURS, 24, 1, 168) * 60 * 60 * 1000;
    const limiter = createFixedWindowLimiter(requestsPerMinute, 60 * 1000, now);
    let provider = null;
    if (providerName === 'kokoro') {
        const legacyVoiceOverride = String(env.KOKORO_VOICE || '').trim();
        provider = createKokoroProvider({
            baseUrl: env.KOKORO_TTS_URL || 'http://kokoro-tts:8880',
            voices: {
                warm: legacyVoiceOverride || env.KOKORO_VOICE_WARM || 'af_heart',
                neutral: legacyVoiceOverride || env.KOKORO_VOICE_NEUTRAL || 'af_nova',
                gentle: legacyVoiceOverride || env.KOKORO_VOICE_GENTLE || 'af_nicole',
            },
            model: env.KOKORO_MODEL || 'kokoro',
            responseFormat: env.KOKORO_RESPONSE_FORMAT || 'mp3', baseSpeed: clampNumber(env.KOKORO_SPEED, 1, 0.75, 1.25),
            timeoutMs: Math.round(clampNumber(env.H_TTS_TIMEOUT_MS, 25000, 1000, 60000)),
            maxAudioBytes: Math.round(clampNumber(env.H_TTS_MAX_AUDIO_BYTES, 8 * 1024 * 1024, 1024, 25 * 1024 * 1024)), fetchImpl,
        });
    } else if (providerName !== 'disabled' && providerName !== 'none') throw new Error(`Unsupported TTS provider: ${providerName}`);

    async function cleanupExpired() {
        await fs.mkdir(storageDir, { recursive: true });
        const entries = await fs.readdir(storageDir, { withFileTypes: true });
        const cutoff = now() - ttlMs;
        await Promise.all(entries.map(async entry => {
            if (!entry.isFile() || !/^[a-f0-9-]{36}\.(mp3|wav)$/.test(entry.name)) return;
            const filePath = path.join(storageDir, entry.name);
            const stats = await fs.stat(filePath);
            if (stats.mtimeMs < cutoff) await fs.unlink(filePath);
        }));
    }
    async function init() {
        await cleanupExpired();
        const timer = setInterval(() => cleanupExpired().catch(err => console.warn('TTS audio cleanup failed:', err.message)), Math.min(ttlMs, 60 * 60 * 1000));
        timer.unref();
    }
    async function saveSynthesis(text, emotion) {
        const audio = await provider.synthesize(text, { emotion });
        await fs.mkdir(storageDir, { recursive: true });
        const id = crypto.randomUUID();
        const fileName = `${id}.${audio.extension}`;
        const filePath = path.join(storageDir, fileName);
        const temporaryPath = `${filePath}.tmp`;
        await fs.writeFile(temporaryPath, audio.buffer, { flag: 'wx' });
        await fs.rename(temporaryPath, filePath);
        return { status: 'ready', url: `/api/h-audio/${fileName}`, mimeType: audio.mimeType, provider: audio.provider, voice: audio.voice, profile: audio.profile, label: 'AI voice' };
    }
    function startSession(clientKey) {
        if (!provider) return { status: 'disabled' };
        if (!limiter.consume(clientKey)) return { status: 'rate_limited' };
        return { status: 'ready', async generate(text, { emotion } = {}) {
            if (typeof text !== 'string' || !text.trim()) return { status: 'empty' };
            if (text.length > maxChars) return { status: 'skipped_length', maxChars };
            return saveSynthesis(text, emotion);
        } };
    }
    async function generate(text, { clientKey, emotion } = {}) {
        if (typeof text !== 'string' || !text.trim()) return { status: 'empty' };
        if (text.length > maxChars) return { status: 'skipped_length', maxChars };
        const session = startSession(clientKey);
        if (session.status !== 'ready') return session;
        return session.generate(text, { emotion });
    }
    async function resolveAudioFile(fileName) {
        if (!/^[a-f0-9-]{36}\.(mp3|wav)$/.test(String(fileName || ''))) return null;
        const filePath = path.join(storageDir, fileName);
        try {
            const stats = await fs.stat(filePath);
            if (!stats.isFile() || stats.mtimeMs < now() - ttlMs) return null;
            return { filePath, mimeType: fileName.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' };
        } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    }
    return { init, startSession, generate, resolveAudioFile, cleanupExpired };
}

module.exports = { DEFAULT_SPEED_BY_EMOTION, VOICE_PROFILE_BY_EMOTION, voiceProfileForEmotion, createFixedWindowLimiter, createNaturalSpeechChunker, prepareTextForSpeech, createKokoroProvider, createTtsService };
