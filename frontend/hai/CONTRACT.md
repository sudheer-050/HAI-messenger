# Quick Actions (HAI) text-command parser contract

Standalone, deterministic. `actionParser.js` takes a typed instruction string
and returns a structured result — nothing else. No DOM, no network, no
AI/LLM, no semantic guessing, no contact-list access. Wired into
`index.html` via a small `<script type="module">` bootstrap that assigns
`window.parseQuickAction = parseQuickAction` — the actual Quick Actions panel
UI, recipient resolution, and dispatch to real app actions all live in
`index.html`'s existing classic script, which is the only place with access
to the live contact list / socket / DOM.

## API

```js
import { parseQuickAction } from './actionParser.js';

parseQuickAction('open chat with maria');
// => { ok: true, action: { type: 'open_chat', args: { chatName: 'maria' } }, requiresConfirmation: false }

parseQuickAction('log me out');
// => { ok: false, reason: 'blocked', detail: '...' }
```

Success: `{ ok: true, action: { type, args }, requiresConfirmation }`.
Failure: `{ ok: false, reason, detail, ...extra }` where `reason` is one of
`unknown | incomplete | blocked | ambiguous`. A failure result carries no
action for a caller to act on — `blocked`/`unknown`/`incomplete` mean "do
nothing"; `ambiguous` means "ask the user" (`candidates` carries the closest
real settings to suggest, for the settings grammar only — recipient
ambiguity is resolved by index.html against the real contact list, not by
this module; see below).

## Commands (v1)

| type | trigger phrasing | args | confirmation |
|---|---|---|---|
| `open_chat` | open [chat] [with] X, start [a] [new] chat with X, go to X, show me X, switch to X | `chatName` | none (Tier C) |
| `search` | search [for] X, look for X, find X | `query` | none (Tier C) |
| `semantic_search` | find [my] conversation(s)/messages [about] X, what did ... talk/say/discuss about X | `query` | none (Tier C) |
| `send_message` (keyword-delimited) | send [[a] message] [to] X saying Y, message/text X saying Y | `chatName`, `message` (fully resolved here) | **always** (Tier A) |
| `send_message` (natural) | tell X..., message X..., text X... (no "saying") | `chatName: null`, `message: null`, `freeText` (unresolved — index.html splits against real contacts) | **always** (Tier A) |
| `change_setting` | turn on/off `<setting>`, set `<setting>` to `<value>`, make the text bigger/smaller | `setting`, `value` (or `relative` for font shorthand), `tier` | Tier A settings only (`read receipts`, `last seen`) |

`semantic_search` triggers are checked **before** the generic `search`
triggers so "find messages about X" doesn't fall through to a plain keyword
search — both ultimately share the verb "find".

## Settings (v1 slice — `TEXT_SETTINGS`)

Deliberately narrower than (and independent from) `frontend/voice`'s
`SETTINGS_ALLOWLIST` — that list is voice's own, broader, not-yet-wired
scope. Quick Actions v1 ships exactly the 5 settings approved in the Stage-1
UX spec (MYAG-181 §2C):

| phrase | key | kind | tier |
|---|---|---|---|
| read receipts | `read_receipts` | bool | A — visible to others |
| last seen | `last_seen` | bool | A — visible to others |
| notification sound | `notif_sound` | bool | B — local, one-tap undo |
| enter is send | `enter_is_send` | bool | B |
| font size | `font_size` | enum (`small`/`medium`/`large`) | B |

A phrase that's a real app concept but not a single setting (e.g.
"notifications" — the app has no master notification switch, only
Notification Sound) clarifies against the closest real setting instead of
guessing: `{ ok: false, reason: 'ambiguous', kind: 'setting', candidates: [...] }`.

"make the text bigger/smaller" returns `{ setting: 'font_size', value: null,
relative: 1 | -1 }` — this module holds no app state, so index.html resolves
the actual next size against the user's current setting before showing
anything.

## Recipient resolution (why it isn't here)

`send_message`'s `chatName`/`freeText` are raw text, never resolved against
an account's actual contacts by this module — this file has no contact list
and must stay that way to stay a pure, drop-in-testable unit. index.html
resolves them (case-insensitive match against `conversationHistory` +
`friendsSet`) and is responsible for:
- **unknown** — no contact matches → show "not in contacts" with a manual
  search fallback, never a guess.
- **ambiguous** — more than one contact matches → list all candidates for
  the user to pick, never silently take the first (this is the specific gap
  Stage-1's UX spec found in the existing voice feature's
  `resolveContactByName` and required Quick Actions not repeat).
- **exactly one match** — resolved; proceed to the Tier-A send preview.

For the natural "tell X ..." grammar, index.html additionally has to find
where the recipient name ends and the message begins, since there's no
keyword separating them — it does this by trying progressively longer
word-prefixes of `freeText` against the real contact list and taking the
longest prefix that yields at least one match.

## Fail-closed rules

- **blocked** — the instruction matches `BLOCKED_PATTERNS`, imported
  directly from `frontend/voice/commandRegistry.js` so voice and Quick
  Actions can never disagree on what's forbidden (login/logout, password,
  account deletion, chat PIN/lock, history clearing, admin, other
  destructive/security actions). Checked before any grammar parsing, so no
  rephrasing routes around it.
- **unknown** — no registered trigger matched, or a `change_setting` target
  isn't in `TEXT_SETTINGS`.
- **incomplete** — a trigger matched but a required argument is missing or
  empty (including a bare `tell`/`message`/`text` with nothing after it).
- **ambiguous** — a settings phrase matches more than one real setting
  (`kind: 'setting'`); recipient ambiguity is a separate concern resolved by
  index.html (see above), not surfaced as this module's `ambiguous`.

## Tests

`node --test` inside `frontend/hai/` (Node's built-in test runner, no extra
dependency). Covers blocked patterns (including one embedded inside an
otherwise send-shaped sentence), both send grammars (verbatim casing/
punctuation preserved in the message body), search/semantic-search
precedence, all 5 settings across both confirmation tiers, the settings
ambiguity clarification, and unknown/incomplete fail-closed cases.
