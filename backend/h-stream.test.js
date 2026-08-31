'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createReplyStreamParser, extractPartialJsonString, streamHReplyContent } = require('./h-stream');

test('partial JSON reply parser decodes escapes and emits only new final-text characters', () => {
    const parser = createReplyStreamParser();
    const pieces = ['{"emotion":"sad","rep', 'ly":"I am sorry.\\nWould ', 'you like to talk?"}'];
    let spoken = '';
    for (const piece of pieces) spoken += parser.push(piece).delta;
    const final = parser.finish();
    spoken += final.delta;
    assert.equal(spoken, 'I am sorry.\nWould you like to talk?');
    assert.equal(final.reply, spoken);
    assert.equal(final.emotion, 'sad');
});

test('extractPartialJsonString does not expose an incomplete escape sequence', () => {
    assert.deepEqual(extractPartialJsonString('{"reply":"hello\\', 'reply'), { value: 'hello', complete: false, found: true });
});

test('local-only provider failure is explicit when no Ollama endpoint is available', async () => {
    await assert.rejects(
        streamHReplyContent({}, [], async () => {}),
        /No H AI provider available/
    );
});
