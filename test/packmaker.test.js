import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { savePack, loadPacks, slugify } from "../src/packs.js";

const q = (text, t = "multiple_choice") =>
  t === "true_false"
    ? { type: t, question: text, choices: ["True", "False"], correctIndex: 1 }
    : { type: t, question: text, choices: ["a", "b", "c", "d"], correctIndex: 2 };

test("savePack creates a new pack and merges into an existing one without duplicates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
  const r1 = savePack("80s Music", [q("One?"), q("Two?", "true_false")], "", dir);
  assert.equal(r1.file, "80s-music.json");
  assert.equal(r1.added, 2);
  const r2 = savePack("80S MUSIC", [q("two?"), q("Three?")], "", dir);
  assert.equal(r2.file, "80s-music.json");
  assert.equal(r2.added, 1);
  assert.equal(r2.total, 3);
  const packs = loadPacks(dir);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].questions[2].correctIndex, 2, "correct answer position preserved");
  fs.rmSync(dir, { recursive: true });
});

test("slugify makes safe filenames", () => {
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("!!!"), "pack");
});
