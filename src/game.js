// Core game state machine for one room. Transport-agnostic: it talks to the
// outside world only through the `io` adapter passed to the constructor:
//   io.toRoom(event, payload)            broadcast to everyone in the room
//   io.toPlayer(playerId, event, payload) send to a single player
import { buildCategory, aiAvailable } from "./questionGen.js";
import { listPacks } from "./packs.js";

export const PHASES = {
  SETUP: "setup", // host configures categories; players wait in lobby
  READY: "ready", // questions built, waiting for host to show first question
  QUESTION: "question", // question live, timer running
  REVEAL: "reveal", // correct answer shown briefly
  LEADERBOARD: "leaderboard", // cumulative top 5, waiting for host to advance
  FINAL: "final", // winner announced
};

export const LIMITS = {
  maxCategories: 8,
  maxPerCategory: 25,
  maxTotalQuestions: 60,
  minTime: 5,
  maxTime: 60,
  maxNameLength: 20,
};

export const REVEAL_MS = 3500;
const MAX_POINTS = 1000;
const MIN_CORRECT_POINTS = 500;

let nextCategoryId = 1;

/** Points for a correct answer: 1000 for an instant answer, sliding to 500 at the buzzer. */
export function scoreAnswer(correct, elapsedMs, limitMs) {
  if (!correct) return 0;
  const frac = Math.min(Math.max(elapsedMs / limitMs, 0), 1);
  return Math.round(MIN_CORRECT_POINTS + (MAX_POINTS - MIN_CORRECT_POINTS) * (1 - frac));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sanitizeName(name) {
  return String(name ?? "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, LIMITS.maxNameLength);
}

export class Room {
  constructor(pin, host, io, { generator = buildCategory, revealMs = REVEAL_MS } = {}) {
    this.pin = pin;
    this.io = io;
    this.generator = generator;
    this.revealMs = revealMs;
    this.hostId = host.id;
    this.players = new Map();
    this.phase = PHASES.SETUP;
    this.settings = { timeLimit: 20 };
    this.categories = [];
    this.questions = [];
    this.currentIndex = -1;
    this.answers = new Map();
    this.questionStartedAt = 0;
    this.timer = null;
    this.lastLeaderboard = null;
    this.lastActivity = Date.now();
    this.addPlayer(host);
  }

  // ---------- players ----------

  addPlayer({ id, name, emoji }) {
    const existing = this.players.get(id);
    if (existing) {
      existing.connected = true;
      if (name) existing.name = sanitizeName(name) || existing.name;
      if (emoji) existing.emoji = String(emoji).slice(0, 16);
      return existing;
    }
    const player = {
      id,
      name: sanitizeName(name) || "Player",
      emoji: String(emoji || "🙂").slice(0, 16),
      score: 0,
      connected: true,
      joinedAt: Date.now(),
    };
    this.players.set(id, player);
    return player;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    // If the last player still thinking leaves, close the question early.
    if (!connected && this.phase === PHASES.QUESTION) {
      const remaining = this.connectedPlayers();
      if (remaining.length && remaining.every((x) => this.answers.has(x.id))) {
        setTimeout(() => this.endQuestion(), 400);
      }
    }
  }

  removePlayer(id) {
    this.players.delete(id);
    this.answers.delete(id);
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  isHost(id) {
    return id === this.hostId;
  }

  // ---------- public state (never contains answers of live questions) ----------

  publicPlayers() {
    return [...this.players.values()].map(({ id, name, emoji, score, connected }) => ({
      id,
      name,
      emoji,
      score,
      connected,
      isHost: id === this.hostId,
    }));
  }

  publicCategories() {
    return this.categories.map(({ id, topic, count, status, source, error, questions }) => ({
      id,
      topic,
      count,
      status,
      source,
      error: status === "error" ? error : undefined,
      built: questions ? questions.length : 0,
    }));
  }

  currentQuestionPublic() {
    const q = this.questions[this.currentIndex];
    if (!q) return null;
    const elapsed = Date.now() - this.questionStartedAt;
    return {
      index: this.currentIndex,
      total: this.questions.length,
      topic: q.topic,
      type: q.type,
      question: q.question,
      choices: q.choices,
      timeLimit: this.settings.timeLimit,
      remainingMs: Math.max(0, this.settings.timeLimit * 1000 - elapsed),
      answeredCount: this.answers.size,
      playerCount: this.connectedPlayers().length,
    };
  }

  snapshot(forPlayerId) {
    const snap = {
      pin: this.pin,
      phase: this.phase,
      hostId: this.hostId,
      you: forPlayerId,
      players: this.publicPlayers(),
      settings: this.settings,
      categories: this.publicCategories(),
      totalQuestions: this.questions.length,
      currentIndex: this.currentIndex,
    };
    if (this.phase === PHASES.SETUP && forPlayerId === this.hostId) {
      snap.packs = listPacks();
      snap.aiAvailable = aiAvailable();
    }
    if (this.phase === PHASES.QUESTION) {
      snap.question = this.currentQuestionPublic();
      const mine = this.answers.get(forPlayerId);
      snap.yourAnswer = mine ? mine.choice : null;
    }
    if (this.phase === PHASES.REVEAL || this.phase === PHASES.LEADERBOARD) {
      snap.reveal = this.lastReveal;
      snap.leaderboard = this.lastLeaderboard;
    }
    if (this.phase === PHASES.FINAL) snap.final = this.finalResults();
    return snap;
  }

  broadcastState() {
    for (const p of this.players.values()) {
      if (p.connected) this.io.toPlayer(p.id, "state", this.snapshot(p.id));
    }
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ---------- host: setup ----------

  updateSettings({ timeLimit }) {
    if (this.phase !== PHASES.SETUP) throw new Error("Settings can only change before the game starts");
    const t = Math.round(Number(timeLimit));
    if (!Number.isFinite(t)) throw new Error("Invalid time limit");
    this.settings.timeLimit = Math.min(LIMITS.maxTime, Math.max(LIMITS.minTime, t));
    this.broadcastState();
  }

  addCategory(topicRaw, countRaw) {
    if (this.phase !== PHASES.SETUP) throw new Error("Categories can only be added before the game starts");
    const topic = String(topicRaw ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
    if (!topic) throw new Error("Enter a topic or search word");
    const count = Math.round(Number(countRaw));
    if (!Number.isInteger(count) || count < 1 || count > LIMITS.maxPerCategory) {
      throw new Error(`Choose between 1 and ${LIMITS.maxPerCategory} questions`);
    }
    if (this.categories.length >= LIMITS.maxCategories) {
      throw new Error(`At most ${LIMITS.maxCategories} categories`);
    }
    const total = this.categories.reduce((s, c) => s + c.count, 0) + count;
    if (total > LIMITS.maxTotalQuestions) {
      throw new Error(`At most ${LIMITS.maxTotalQuestions} questions per game`);
    }

    const category = { id: nextCategoryId++, topic, count, status: "building", questions: null };
    this.categories.push(category);
    this.broadcastState();

    const used = new Set(this.categories.flatMap((c) => (c.questions || []).map((q) => q.question)));
    this.generator(topic, count, used)
      .then(({ questions, source, error }) => {
        if (!this.categories.includes(category)) return; // removed meanwhile
        if (!questions.length) {
          category.status = "error";
          category.error = error || "Could not build questions";
        } else {
          category.status = "ready";
          category.questions = questions;
          category.source = source;
          if (source === "fallback") category.error = error;
        }
        this.broadcastState();
      })
      .catch((err) => {
        category.status = "error";
        category.error = err.message;
        this.broadcastState();
      });
    return category;
  }

  removeCategory(id) {
    if (this.phase !== PHASES.SETUP) throw new Error("Game already started");
    this.categories = this.categories.filter((c) => c.id !== id);
    this.broadcastState();
  }

  // ---------- host: game flow ----------

  startGame() {
    if (this.phase !== PHASES.SETUP) throw new Error("Game already started");
    if (this.categories.some((c) => c.status === "building")) throw new Error("Questions are still being built");
    const ready = this.categories.filter((c) => c.status === "ready");
    if (!ready.length) throw new Error("Add at least one category first");

    // Mix the categories together so topics alternate unpredictably.
    this.questions = shuffle(ready.flatMap((c) => c.questions));
    for (const p of this.players.values()) {
      p.score = 0;
      p.correctCount = 0;
    }
    this.currentIndex = -1;
    this.lastLeaderboard = null;
    this.lastReveal = null;
    this.phase = PHASES.READY;
    this.broadcastState();
  }

  nextQuestion() {
    if (![PHASES.READY, PHASES.LEADERBOARD].includes(this.phase)) {
      throw new Error("Can't advance right now");
    }
    if (this.currentIndex + 1 >= this.questions.length) {
      this.phase = PHASES.FINAL;
      this.broadcastState();
      return;
    }
    this.currentIndex += 1;
    this.answers = new Map();
    this.questionStartedAt = Date.now();
    this.phase = PHASES.QUESTION;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.endQuestion(), this.settings.timeLimit * 1000 + 250);
    this.broadcastState();
  }

  submitAnswer(playerId, choiceRaw) {
    if (this.phase !== PHASES.QUESTION) return { ok: false, error: "No question is open" };
    if (!this.players.has(playerId)) return { ok: false, error: "Unknown player" };
    if (this.answers.has(playerId)) return { ok: false, error: "Already answered" };
    const q = this.questions[this.currentIndex];
    const choice = Number(choiceRaw);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.choices.length) {
      return { ok: false, error: "Invalid choice" };
    }
    const elapsed = Date.now() - this.questionStartedAt;
    if (elapsed > this.settings.timeLimit * 1000 + 250) return { ok: false, error: "Time is up" };
    this.answers.set(playerId, { choice, elapsed });

    this.io.toRoom("answerCount", {
      answeredCount: this.answers.size,
      playerCount: this.connectedPlayers().length,
    });

    const everyoneIn = this.connectedPlayers().every((p) => this.answers.has(p.id));
    if (everyoneIn) setTimeout(() => this.endQuestion(), 400);
    return { ok: true };
  }

  rankings() {
    return [...this.players.values()].sort(
      (a, b) => b.score - a.score || a.joinedAt - b.joinedAt,
    );
  }

  endQuestion() {
    if (this.phase !== PHASES.QUESTION) return;
    clearTimeout(this.timer);
    const q = this.questions[this.currentIndex];
    const limitMs = this.settings.timeLimit * 1000;

    const prevRanks = new Map(this.rankings().map((p, i) => [p.id, i + 1]));
    const results = {};
    for (const p of this.players.values()) {
      const a = this.answers.get(p.id);
      const correct = !!a && a.choice === q.correctIndex;
      const points = a ? scoreAnswer(correct, a.elapsed, limitMs) : 0;
      p.score += points;
      if (correct) p.correctCount = (p.correctCount || 0) + 1;
      results[p.id] = { answered: !!a, choice: a ? a.choice : null, correct, points, ms: a ? a.elapsed : null };
    }

    const ranked = this.rankings();
    this.lastLeaderboard = {
      questionIndex: this.currentIndex,
      total: this.questions.length,
      isLast: this.currentIndex + 1 >= this.questions.length,
      entries: ranked.map((p, i) => ({
        id: p.id,
        name: p.name,
        emoji: p.emoji,
        score: p.score,
        rank: i + 1,
        prevRank: prevRanks.get(p.id) ?? i + 1,
        points: results[p.id]?.points ?? 0,
      })),
    };
    const counts = q.choices.map((_, i) => [...this.answers.values()].filter((a) => a.choice === i).length);
    this.lastReveal = {
      questionIndex: this.currentIndex,
      question: q.question,
      type: q.type,
      choices: q.choices,
      correctIndex: q.correctIndex,
      counts,
      results,
    };
    this.phase = PHASES.REVEAL;
    this.broadcastState();

    this.timer = setTimeout(() => {
      if (this.phase !== PHASES.REVEAL) return;
      this.phase = PHASES.LEADERBOARD;
      this.broadcastState();
    }, this.revealMs);
  }

  finalResults() {
    const ranked = this.rankings();
    return {
      total: this.questions.length,
      standings: ranked.map((p, i) => ({
        id: p.id,
        name: p.name,
        emoji: p.emoji,
        score: p.score,
        correct: p.correctCount || 0,
        rank: i + 1,
      })),
    };
  }

  backToMenu() {
    if (this.phase !== PHASES.FINAL) throw new Error("The game isn't over yet");
    clearTimeout(this.timer);
    this.phase = PHASES.SETUP;
    this.categories = [];
    this.questions = [];
    this.currentIndex = -1;
    this.answers = new Map();
    this.lastLeaderboard = null;
    this.lastReveal = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.correctCount = 0;
    }
    // Drop players who left during the game.
    for (const p of [...this.players.values()]) {
      if (!p.connected && p.id !== this.hostId) this.players.delete(p.id);
    }
    this.broadcastState();
  }

  destroy() {
    clearTimeout(this.timer);
  }
}
