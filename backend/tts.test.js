'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createFixedWindowLimiter, createNaturalSpeechChunker, prepareTextForSpeech, voiceProfileForEmotion, createTtsService } = require('./tts');

test('fixed-window limiter resets after the window', () => {
    let current = 1000;
    const limiter = createFixedWindowLimiter(2, 60_000, () => current);
    assert.equal(limiter.consume('visitor'), true); assert.equal(limiter.consume('visitor'), true); assert.equal(limiter.consume('visitor'), false);
    current += 60_000; assert.equal(limiter.consume('visitor'), true);
});

test('natural chunker emits boundaries without changing final text', () => {
    const chunker = createNaturalSpeechChunker({ minChars: 20, maxChars: 55 });
    const original = 'This is the first complete thought. Here is a longer second thought, with a natural pause before it finishes.';
    const chunks = [...chunker.push(original.slice(0, 18)), ...chunker.push(original.slice(18, 63)), ...chunker.push(original.slice(63)), ...chunker.flush()];
    assert.ok(chunks.length >= 2); assert.equal(chunks.join(''), original); assert.ok(chunks.every(chunk => chunk.length <= 60));
});

test('default chunker buffers short sentences to prevent playback underruns', () => {
    const chunker = createNaturalSpeechChunker();
    const first = 'That makes sense. Let us keep going. ';
    assert.deepEqual(chunker.push(first), []);
    const rest = 'Here is a longer natural thought that gives the local synthesizer enough audio to prepare the following phrase without a long punctuation gap. ';
    const chunks = [...chunker.push(rest), ...chunker.flush()];
    assert.ok(chunks.length >= 1);
    assert.ok(chunks[0].length >= 120);
    assert.equal(chunks.join(''), first + rest);
});

test('speech preprocessing shortens exaggerated punctuation without changing words', () => {
    assert.equal(prepareTextForSpeech('  Wait!!!   Really...?  '), 'Wait! Really?');
});

test('emotion intents map to a small deterministic set of voice profiles', () => {
    assert.equal(voiceProfileForEmotion('happy'), 'warm');
    assert.equal(voiceProfileForEmotion('concerned'), 'gentle');
    assert.equal(voiceProfileForEmotion('sad'), 'gentle');
    assert.equal(voiceProfileForEmotion('curious'), 'neutral');
    assert.equal(voiceProfileForEmotion('unexpected'), 'neutral');
});

test('Kokoro synthesis is saved as a labeled AI voice attachment', async t => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hurricane-tts-'));
    t.after(() => fs.rm(storageDir, { recursive: true, force: true }));
    let requestBody;
    const service = createTtsService({ env: { TTS_PROVIDER: 'kokoro', TTS_STORAGE_DIR: storageDir, KOKORO_TTS_URL: 'http://kokoro.test', KOKORO_VOICE_WARM: 'af_heart', KOKORO_VOICE_NEUTRAL: 'af_nova', KOKORO_VOICE_GENTLE: 'af_nicole' }, fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body); return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([0x49, 0x44, 0x33]).buffer };
    } });
    const result = await service.generate('That sounds wonderful.', { clientKey: 'visitor', emotion: 'happy' });
    assert.equal(result.status, 'ready'); assert.equal(result.label, 'AI voice'); assert.match(result.url, /^\/api\/h-audio\/[a-f0-9-]{36}\.mp3$/);
    assert.equal(requestBody.input, 'That sounds wonderful.'); assert.equal(requestBody.voice, 'af_heart'); assert.ok(requestBody.speed > 1);
    assert.equal(result.profile, 'warm');
    const saved = await service.resolveAudioFile(path.basename(result.url)); assert.ok(saved); assert.deepEqual(await fs.readFile(saved.filePath), Buffer.from([0x49, 0x44, 0x33]));
});

test('supportive intent uses the gentle local voice profile and slower delivery', async t => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hurricane-tts-'));
    t.after(() => fs.rm(storageDir, { recursive: true, force: true }));
    let requestBody;
    const service = createTtsService({ env: { TTS_PROVIDER: 'kokoro', TTS_STORAGE_DIR: storageDir, KOKORO_VOICE_WARM: 'af_heart', KOKORO_VOICE_NEUTRAL: 'af_nova', KOKORO_VOICE_GENTLE: 'af_nicole' }, fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body); return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1]).buffer };
    } });
    const result = await service.generate('I am sorry this is hard.', { clientKey: 'visitor', emotion: 'concerned' });
    assert.equal(requestBody.voice, 'af_nicole'); assert.ok(requestBody.speed < 1);
    assert.equal(result.profile, 'gentle');
});

test('length and rate guards skip audio without blocking text flow', async t => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hurricane-tts-'));
    t.after(() => fs.rm(storageDir, { recursive: true, force: true }));
    let calls = 0;
    const service = createTtsService({ env: { TTS_PROVIDER: 'kokoro', TTS_STORAGE_DIR: storageDir, H_TTS_MAX_CHARS: '100', H_TTS_MAX_PER_MINUTE: '1' }, fetchImpl: async () => {
        calls += 1; return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer };
    } });
    assert.equal((await service.generate('x'.repeat(101), { clientKey: 'visitor' })).status, 'skipped_length');
    assert.equal((await service.generate('short reply', { clientKey: 'visitor' })).status, 'ready');
    assert.equal((await service.generate('another reply', { clientKey: 'visitor' })).status, 'rate_limited'); assert.equal(calls, 1);
});
