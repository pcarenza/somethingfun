import { test } from "node:test";
import assert from "node:assert/strict";
import { Room, PHASES, scoreAnswer } from "../src/game.js";
import { normalizeQuestion } from "../src/questionGen.js";

const fakeQuestions = (topic, n) =>
  Array.from({ length: n }, (_, i) => ({
    type: i % 2 ? "true_false" : "multiple_choice",
    topic,
    question: `${topic} q${i}`,
    choices: i % 2 ? ["True", "False"] : ["A", "B", "C", "D"],
    correctIndex: 1,
  }));

function makeRoom() {
  const sent = [];
  const io = {
    toRoom: (e, p) => sent.push({ to: "room", e, p }),
    toPlayer: (id, e, p) => sent.push({ to: id, e, p }),
  };
  const generator = async (topic, count) => ({ questions: fakeQuestions(topic, count), source: "ai" });
  const room = new Room("123456", { id: "host-0001", name: "Host", emoji: "🎅" }, io, { generator, revealMs: 200 });
  return { room, sent };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("scoring rewards speed and correctness", () => {
  assert.equal(scoreAnswer(false, 0, 10000), 0);
  assert.equal(scoreAnswer(true, 0, 10000), 1000);
  assert.equal(scoreAnswer(true, 10000, 10000), 500);
  assert.equal(scoreAnswer(true, 5000, 10000), 750);
});

test("normalizeQuestion validates and shuffles", () => {
  const q = normalizeQuestion({ type: "multiple_choice", question: "Q?", choices: ["right", "w1", "w2", "w3"], correctIndex: 0 }, "T");
  assert.equal(q.choices[q.correctIndex], "right");
  const tf = normalizeQuestion({ type: "true_false", question: "Q?", choices: ["False", "True"], correctIndex: 0 }, "T");
  assert.deepEqual(tf.choices, ["True", "False"]);
  assert.equal(tf.correctIndex, 1);
  assert.equal(normalizeQuestion({ type: "multiple_choice", question: "Q", choices: ["a", "b"], correctIndex: 0 }), null);
});

test("snapshots never leak the correct answer during a question", async () => {
  const { room } = makeRoom();
  room.addCategory("Christmas", 3);
  await tick();
  const setupSnap = JSON.stringify(room.snapshot("host-0001"));
  assert.ok(!setupSnap.includes("correctIndex"));
  assert.ok(!setupSnap.includes("Christmas q0"), "host must not see questions in setup");
  room.startGame();
  room.nextQuestion();
  const snap = room.snapshot("host-0001");
  assert.equal(snap.phase, PHASES.QUESTION);
  assert.ok(!JSON.stringify(snap).includes("correctIndex"));
  room.destroy();
});

test("full game flow with cumulative leaderboard and rank movement", async () => {
  const { room } = makeRoom();
  room.addPlayer({ id: "player-0002", name: "Ann", emoji: "🦊" });
  room.updateSettings({ timeLimit: 10 });
  room.addCategory("Space", 2);
  await tick();
  room.startGame();
  assert.equal(room.phase, PHASES.READY);

  // Q1: host wrong, Ann right
  room.nextQuestion();
  room.submitAnswer("host-0001", 0);
  assert.equal(room.submitAnswer("host-0001", 1).ok, false, "no double answers");
  room.submitAnswer("player-0002", 1);
  await tick(450);
  assert.equal(room.phase, PHASES.REVEAL);
  await tick(250);
  assert.equal(room.phase, PHASES.LEADERBOARD);
  const lb1 = room.lastLeaderboard.entries;
  assert.equal(lb1[0].id, "player-0002");
  assert.equal(lb1[0].prevRank, 2);
  assert.equal(lb1[0].rank, 1);

  // Q2: both right -> cumulative
  room.nextQuestion();
  room.submitAnswer("player-0002", 1);
  room.submitAnswer("host-0001", 1);
  await tick(700);
  const ann = room.lastLeaderboard.entries.find((e) => e.id === "player-0002");
  assert.ok(ann.score > 1000, "scores accumulate");
  assert.equal(room.lastLeaderboard.isLast, true);

  room.nextQuestion();
  assert.equal(room.phase, PHASES.FINAL);
  assert.equal(room.finalResults().standings[0].id, "player-0002");

  room.backToMenu();
  assert.equal(room.phase, PHASES.SETUP);
  assert.equal(room.categories.length, 0);
  assert.ok([...room.players.values()].every((p) => p.score === 0));
  room.destroy();
});

test("start is blocked while questions are building", () => {
  const { room } = makeRoom();
  room.generator = () => new Promise(() => {});
  room.addCategory("Slow topic", 3);
  assert.throws(() => room.startGame(), /still being built/);
  room.destroy();
});
