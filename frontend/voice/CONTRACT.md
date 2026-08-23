# Voice command parser contract

Standalone, deterministic. `commandParser.js` takes a transcript string and
returns a structured result — nothing else. No DOM, no network, no AI/LLM,
no semantic guessing. Not wired into `index.html` by this change.

## API

```js
import { parseVoiceCommand } from './commandParser.js';

parseVoiceCommand('open chat mom');
// => { ok: true, command: 'open_chat', args: { chatName: 'mom' } }

parseVoiceCommand('log me out');
// => { ok: false, reason: 'blocked', detail: '...' }
```

Success: `{ ok: true, command: <id>, args: {...} }`.
Failure: `{ ok: false, reason, detail }` where `reason` is one of
`unknown | ambiguous | incomplete | malformed | blocked`. A failure result
carries no usable args — callers must treat it as "do nothing."

## Commands (v1)

| id | trigger synonyms (commandRegistry.js) | args |
|---|---|---|
| `open_chat` | open chat, open, go to, show me | `chatName` |
| `close_chat` | close chat, close the chat, close current chat, exit chat | — |
| `send_message` | send message, dictate message, send | `chatName` (nullable = current chat), `message` — grammar: `[to <chat>] saying <message>` |
| `change_setting` | change setting, change, set | `setting`, `value` — grammar: `<setting> to <value>`, setting name checked against `SETTINGS_ALLOWLIST` |
| `forward_message` | forward selected message, forward message, forward this, forward | `chatName` — grammar: `to <chat>`; forwards the current/selected message (implicit, not spoken) |
| `search` | search for, search, look for, find | `query` |

## Extending

Add a phrase to a command's `synonyms` array in `commandRegistry.js`, or add
an entry to `SETTINGS_ALLOWLIST`. `commandParser.js` never needs to change.
A synonym reused across two different commands throws at import time
(`validateRegistry`) instead of silently matching the wrong command.

## Fail-closed rules

- **unknown** — transcript doesn't start with any registered trigger phrase.
- **ambiguous** — the longest matching trigger phrase is tied between two
  different commands.
- **incomplete** — a command matched but a required argument is missing or
  empty.
- **malformed** — a command matched but the argument text doesn't fit the
  command's fixed grammar (e.g. missing the `saying` / `to` keyword).
- **blocked** — the transcript matches `BLOCKED_PATTERNS`
  (login, logout, password change, account deletion, chat PIN/lock, history
  clearing, admin, other destructive/security actions) or a `change_setting`
  target isn't in `SETTINGS_ALLOWLIST`. Checked before any grammar parsing,
  so no rephrasing routes around it.

## Tests

`node --test` inside `frontend/voice/` (Node's built-in test runner, no
extra dependency). Covers canonical phrases, synonyms, longest-match
overlaps, missing/malformed args, blocked actions, punctuation/case
normalization, and registry-only synonym extension.
