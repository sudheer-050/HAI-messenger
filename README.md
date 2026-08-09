# HAI

![License](https://img.shields.io/badge/license-MIT-blue)
![Docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)
![Node](https://img.shields.io/badge/node-18-339933?logo=node.js&logoColor=white)
![PWA](https://img.shields.io/badge/installable-PWA-5A0FC8)

A self-hosted, end-to-end encrypted chat app. Single-file PWA frontend, a small Node/Express/Socket.IO backend, and a Docker Compose stack you run on your own machine — your messages never touch a third-party server.

## Features

- **End-to-end encryption** — hybrid RSA-OAEP-2048 + AES-256-GCM envelope encryption. The server only ever relays ciphertext.
- **Real-time messaging** — read receipts, typing indicators, message editing, delete for me/everyone, emoji reactions, replies, pinning, starring.
- **Rich media** — photos (with in-app camera capture), voice notes (with live waveform + playback preview before sending), documents, live location sharing.
- **In-chat mini-games** — Tic Tac Toe, Stone Paper Scissors, Truth or Dare, played live against whoever you're chatting with.
- **Nearby** — anonymous, 24-hour self-destructing chats with whoever else is online right now. Neither side ever sees the other's real identity; matches and their messages are permanently deleted after 24 hours, both server-side and on both clients.
- **Ask AI** — an in-chat assistant panel backed by your own local [Ollama](https://ollama.com) instance, so the model call never leaves your machine. Answers questions about the open conversation, searches the web (DuckDuckGo) when it needs current information, and has a hard-coded refusal for anything outside that scope.
- **Installable PWA** — add to home screen on mobile or desktop for a native-feeling app, with offline-safe caching and mobile-first gestures (swipe to delete/favorite, morph transitions).
- **Favorites & unread badges** — star chats, filter by unread/favorites, and see at a glance whether a new notification is a message or a game invite.
- **Internet access via Cloudflare Tunnel** — expose your local instance over HTTPS without opening any ports, protected by HTTP Basic Auth.

## Tech stack

| Component | Role |
|---|---|
| Node.js / Express / Socket.IO | Backend — real-time relay, offline message queue, Ask AI proxy |
| Redis | Online presence, offline message queue, Nearby match/alias state |
| Ollama (external, runs on your host) | Powers the Ask AI assistant |
| Cloudflare Tunnel (`cloudflared`) | Optional internet exposure without port forwarding |
| Vanilla JS, single-file HTML/CSS/JS | Frontend — no build step |

`postgres` and `libretranslate` containers are provisioned in the Compose file but aren't currently wired into the app — left in place for future use rather than actively used today.

## Setup

**Requirements:** Docker Desktop, and optionally [Ollama](https://ollama.com) running on your host machine if you want the Ask AI feature (any model works — set `OLLAMA_MODEL` in `backend/server.js` to match whichever you've pulled).

1. Clone the repo and copy the environment template:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` and set your own values — in particular `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`, which gate every request to the app.
3. Start the stack:
   ```bash
   docker compose up -d --build
   ```
4. Open `http://localhost:3000` and log in with the Basic Auth credentials from your `.env`.

All service ports are bound to `127.0.0.1` only — nothing is exposed to your network by default.

### Going online (optional)

The `cloudflared` service opens a free Cloudflare Quick Tunnel automatically. Get the current public URL with:
```bash
docker compose logs cloudflared | grep trycloudflare.com
```
Quick Tunnels mint a new URL every time the container restarts and can drop after several hours — restart the service (`docker compose restart cloudflared`) to get a fresh one if it stops responding. Basic Auth still applies over the tunnel, so the link alone isn't enough to get in.

## Project structure

```
backend/          Express + Socket.IO server
frontend/         Single-file PWA (index.html, manifest, service worker, icons)
docker-compose.yml
.env.example       Copy to .env and fill in your own values
```

## License

MIT — see [LICENSE](LICENSE).
