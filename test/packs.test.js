import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePack, listPacks } from "../src/packs.js";
import { buildCategory } from "../src/questionGen.js";

test("validatePack catches malformed questions", () => {
  assert.deepEqual(validatePack({ topic: "X", questions: [{ type: "true_false", question: "Q", choices: ["True", "False"], correctIndex: 0 }] }), []);
  const bad = validatePack({ topic: "X", questions: [{ type: "multiple_choice", question: "Q", choices: ["a", "a", "b", "c"], correctIndex: 5 }] });
  assert.ok(bad.length >= 2);
});

test("a matching pack is used case-insensitively and listing hides questions", async () => {
  const listed = listPacks();
  assert.ok(listed.some((p) => p.topic === "Christmas"));
  assert.ok(!JSON.stringify(listed).includes("correctIndex"));
  const r = await buildCategory("  christmas ", 10);
  assert.equal(r.source, "pack");
  assert.equal(r.questions.length, 10);
  assert.ok(r.questions.every((q) => q.topic === "Christmas"));
});

test("unknown topic without an API key falls back to the general bank", async () => {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return;
  const r = await buildCategory("Underwater basket weaving", 3);
  assert.equal(r.source, "fallback");
  assert.equal(r.questions.length, 3);
});
