# Flock: think like the herd

A phone party game. One player names a category, everyone secretly writes an answer,
and you score **1 point for every other player who wrote the same thing**. No match = 0.

No app store and no accounts. Friends scan a QR code or type a 4-letter room code in their phone browser.

## Deploy to Cloudflare (free plan, about 5 minutes)

You need a computer with Node.js 18+ and a free Cloudflare account.

```bash
cd flock
npm install
npx wrangler login      # opens a browser to sign in to Cloudflare
npm run deploy
```

Wrangler prints your URL, e.g. `https://flock-game.<you>.workers.dev`. Open it on your phone and you're done.
Optional: add a custom domain in the Cloudflare dashboard (Workers → flock-game → Settings → Domains).

Run locally: `npm run dev`, then open http://localhost:8787. Tests: `npm test`.

## How it works

- **Cloudflare Worker** serves the app and routes `/ws/<CODE>` WebSockets.
- **One Durable Object per room** holds the game state, so every phone in a room talks to the same instance.
  The server is the single source of truth for scoring; phones just display it.
- WebSocket hibernation keeps idle rooms nearly free; state is saved after every move, so nothing is lost.
- One alarm per room drives the answer timer, host hand-over and cleanup (rooms delete after 6h idle).

```
src/game.js        rules, rounds, scoring (pure JS, unit-tested)
src/match.js       answer matching: case, punctuation, "the", plurals, number words, typos
src/categories.js  built-in category decks
src/worker.js      Worker + Room Durable Object
public/            phone app (vanilla JS, no build step) + TV screen
```

## Features

- Join by QR code, link or 4-letter code (no vowels, so no rude words; no O/0 or I/1 mix-ups)
- Smart matching: "The Beatles" = "beatles!" = "Beatels"; "seven" = "7"; "cat" ≠ "car"
- Host can **merge** answers that mean the same thing (Coke + Coca-Cola) or **split** one out. Scores update live
- Shows how each person spelled it, so arguments are settled fast
- Asker rotates every round; 🎲 "Surprise me" draws from 5 decks (incl. an Aussie deck)
- Optional answer timer; auto-reveal when everyone's locked in, or when a phone drops out
- Answers stay hidden on the server until the reveal (no peeking via dev tools)
- Survives phones sleeping: auto-reconnect, refresh puts you back in your seat, host passes on if the host leaves
- Keyboard never closes while you type, even as others' answers arrive
- **TV mode** (`/tv/CODE`): big-screen view with QR, live reveal and scores
- Sound effects, vibration, screen stays awake, confetti, podium and end-of-game awards
  (Mind melders, Black sheep, Biggest herd)
- Installable to home screen (PWA), works in light conditions, respects reduced motion
