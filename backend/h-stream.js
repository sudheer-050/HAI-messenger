'use strict';

function extractPartialJsonString(source, key) {
    const keyMatch = new RegExp(`"${key}"\\s*:\\s*"`).exec(source);
    if (!keyMatch) return { value: '', complete: false, found: false };
    let index = keyMatch.index + keyMatch[0].length;
    let value = '';
    while (index < source.length) {
        const char = source[index++];
        if (char === '"') return { value, complete: true, found: true };
        if (char !== '\\') { value += char; continue; }
        if (index >= source.length) break;
        const escaped = source[index++];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (escaped === 'u') {
            const hex = source.slice(index, index + 4);
            if (!/^[0-9a-f]{4}$/i.test(hex)) break;
            value += String.fromCharCode(parseInt(hex, 16));
            index += 4;
        } else if (Object.prototype.hasOwnProperty.call(simple, escaped)) value += simple[escaped];
        else value += escaped;
    }
    return { value, complete: false, found: true };
}

function createReplyStreamParser() {
    let raw = '';
    let emitted = '';
    let emotion = 'neutral';
    return {
        push(content) {
            raw += content || '';
            const emotionMatch = raw.match(/"emotion"\s*:\s*"(happy|excited|calm|curious|concerned|sad|neutral)"/);
            if (emotionMatch) emotion = emotionMatch[1];
            const parsed = extractPartialJsonString(raw, 'reply');
            const delta = parsed.value.slice(emitted.length);
            emitted = parsed.value;
            return { delta, emotion, complete: parsed.complete };
        },
        finish() {
            const parsed = extractPartialJsonString(raw, 'reply');
            if (parsed.found) {
                const delta = parsed.value.slice(emitted.length);
                emitted = parsed.value;
                return { delta, reply: emitted, emotion };
            }
            try {
                const value = JSON.parse(raw);
                const reply = value && typeof value.reply === 'string' ? value.reply : raw.trim();
                return { delta: reply.slice(emitted.length), reply, emotion: value && value.emotion || emotion };
            } catch (_err) {
                const reply = raw.trim();
                return { delta: reply.slice(emitted.length), reply, emotion };
            }
        },
    };
}

async function readLines(response, onLine) {
    if (!response.body || !response.body.getReader) throw new Error('Provider did not return a streaming body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) await onLine(line);
        if (done) break;
    }
    if (pending) await onLine(pending);
}

async function streamOllama(endpoint, model, messages, onContent, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${endpoint.url.replace(/\/$/, '')}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...endpoint.headers },
            body: JSON.stringify({ model, messages, stream: true, format: 'json' }), signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Ollama responded ${response.status}`);
        await readLines(response, async line => {
            if (!line.trim()) return;
            const data = JSON.parse(line);
            if (data.message && typeof data.message.content === 'string') await onContent(data.message.content);
        });
    } finally { clearTimeout(timer); }
}

async function streamOpenAiCompatible(url, apiKey, model, messages, onContent, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, stream: true }), signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Streaming provider responded ${response.status}`);
        await readLines(response, async line => {
            if (!line.startsWith('data:')) return;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            const data = JSON.parse(payload);
            const content = data && data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
            if (typeof content === 'string') await onContent(content);
        });
    } finally { clearTimeout(timer); }
}

async function streamHReplyContent(config, messages, onReplyDelta) {
    const endpoints = [];
    if (config.ollamaUrl) endpoints.push({ url: config.ollamaUrl, headers: {} });
    if (config.ollamaLocalUrl) endpoints.push({ url: config.ollamaLocalUrl, headers: config.ollamaLocalSecret ? { 'X-Proxy-Secret': config.ollamaLocalSecret } : {} });
    let lastError = null;
    for (const endpoint of endpoints) {
        const parser = createReplyStreamParser();
        let emittedAny = false;
        try {
            await streamOllama(endpoint, config.ollamaModel, messages, async content => {
                const parsed = parser.push(content);
                if (parsed.delta) { emittedAny = true; await onReplyDelta(parsed.delta, parsed.emotion); }
            }, config.timeoutMs || 30000);
            const final = parser.finish();
            if (final.delta) await onReplyDelta(final.delta, final.emotion);
            if (final.reply) return final;
            throw new Error('Ollama returned an empty reply');
        } catch (err) {
            if (emittedAny) throw err;
            lastError = err;
        }
    }
    if (config.geminiApiKey) {
        const parser = createReplyStreamParser();
        await streamOpenAiCompatible('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', config.geminiApiKey, config.geminiModel, messages, async content => {
            const parsed = parser.push(content);
            if (parsed.delta) await onReplyDelta(parsed.delta, parsed.emotion);
        }, config.timeoutMs || 30000);
        const final = parser.finish();
        if (final.delta) await onReplyDelta(final.delta, final.emotion);
        if (final.reply) return final;
        throw new Error('Gemini returned an empty reply');
    }
    throw lastError || new Error('No H AI provider available');
}

module.exports = { extractPartialJsonString, createReplyStreamParser, streamHReplyContent };
