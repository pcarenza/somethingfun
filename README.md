# Trivia Party 🎉

A multiplayer trivia web app. The host creates a game and shares a 6-digit PIN, everyone joins from their own phone or laptop, and the host plays too. The host types any topic ("Christmas", "90s movies", "Space") and the app uses Claude to write the questions. Nobody sees the questions or answers before they're played, not even the host.

## Features

- **PIN rooms**: the host creates a game and gets a PIN. Players join with the PIN, a name and an emoji avatar. You can also share a link like `http://host:3000/?pin=123456`.
- **AI-generated question sets**: add one or more categories, each with its own number of questions (up to 8 categories, 60 questions per game). Claude decides for each question whether it works better as **multiple choice** (1 correct out of 4) or **true/false**.
- **Answers stay on the server**: the correct answer is only sent to players after the question closes. The host's setup screen shows just "✓ 10 hidden questions ready".
- **Host-paced play**: the host clicks *Show first question* or *Next question*. Each question has a countdown (5–60 seconds, set by the host) and ends early once everyone has answered.
- **Speed scoring**: a correct answer earns 500–1000 points, with more points the faster you answer. A wrong answer or no answer earns 0.
- **Animated cumulative leaderboard**: after the answer is revealed, the top 5 slide into their new positions. #1 gets a gold glow and a crown, big climbs get a 🚀 and a flash, big drops get a wobble, and scores count up. If you're not in the top 5, you see your own rank.
- **Winner screen**: confetti, the winner, a podium and the full standings. The host clicks *Back to main menu* to set up another round with the same players.
- **Reconnects**: if you refresh or lose your connection, you rejoin your game automatically.

## Running it

Requires Node 18+.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional: lets the host type any topic
npm start                              # http://localhost:3000
```

Open the URL on several devices on the same network (use the host machine's LAN IP, e.g. `http://192.168.1.20:3000`).

## Question packs (no API key needed)

Packs are JSON files in `questions/`. They appear as buttons on the host's setup screen, and each game draws a random sample from the pack. To make a new one, ask Claude in a Claude Code session on this repo, for example *"make a 30-question pack about 80s music"*. Claude writes the file, checks it, commits it and pushes it. If your host redeploys when you push, the new pack shows up on its own. `CLAUDE.md` describes the file format.

Where questions come from, in order:
1. A pack whose topic matches what the host picked or typed.
2. Claude, generating live (only if `ANTHROPIC_API_KEY` is set).
3. A small built-in general-knowledge bank. The host sees a ⚠ when this happens.

`npm run validate-packs` checks every pack for formatting problems.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ANTHROPIC_API_KEY` | – | Claude API key for generating questions |
| `TRIVIA_MODEL` | `claude-opus-5-5` | Model used to generate questions |

Questions are generated with structured JSON output and server-side refusal fallbacks (`fallbacks: "default"`), so a declined request is retried on a fallback model automatically.

## Tests

```bash
npm test
```

## Layout

```
src/server.js       Express + Socket.IO: rooms, PINs, events, reconnects
src/game.js         Game state machine: setup → ready → question → reveal → leaderboard → final
src/questionGen.js  Claude question generation, validation, answer shuffling, offline fallback
src/packs.js        Loads and validates question packs
src/fallbackBank.js Offline general-knowledge questions
questions/          Question packs (JSON)
scripts/            validate-packs.js
public/             Single-page client (vanilla JS/CSS, no build step)
test/               node:test unit tests for the game logic
```

Game state is kept in memory, so restarting the server ends all games. For a multi-instance deployment you'd move rooms into Redis and use the Socket.IO Redis adapter.
