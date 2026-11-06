// Pre-built question packs stored as JSON files in /questions.
// A pack lets the game run topic-based rounds without an API key: the questions
// are written ahead of time (e.g. in a Claude chat) and committed to the repo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKS_DIR = process.env.PACKS_DIR || path.join(__dirname, "..", "questions");

/** Returns a list of problems with a pack object; empty array means valid. */
export function validatePack(pack) {
  const problems = [];
  if (!pack || typeof pack !== "object") return ["pack is not an object"];
  if (typeof pack.topic !== "string" || !pack.topic.trim()) problems.push("missing topic");
  if (!Array.isArray(pack.questions) || pack.questions.length === 0) {
    problems.push("questions must be a non-empty array");
    return problems;
  }
  const seen = new Set();
  pack.questions.forEach((q, i) => {
    const at = `question ${i + 1}`;
    if (typeof q.question !== "string" || !q.question.trim()) problems.push(`${at}: missing question text`);
    const key = String(q.question).trim().toLowerCase();
    if (seen.has(key)) problems.push(`${at}: duplicate question`);
    seen.add(key);
    if (!Array.isArray(q.choices)) {
      problems.push(`${at}: choices must be an array`);
      return;
    }
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.choices.length) {
      problems.push(`${at}: correctIndex out of range`);
    }
    if (q.type === "multiple_choice") {
      const uniq = new Set(q.choices.map((c) => String(c).trim().toLowerCase()));
      if (q.choices.length !== 4 || uniq.size !== 4) problems.push(`${at}: multiple_choice needs 4 distinct choices`);
    } else if (q.type === "true_false") {
      if (q.choices.length !== 2 || q.choices[0] !== "True" || q.choices[1] !== "False") {
        problems.push(`${at}: true_false choices must be exactly ["True", "False"]`);
      }
    } else {
      problems.push(`${at}: type must be multiple_choice or true_false`);
    }
  });
  return problems;
}

/** Load every valid pack. Invalid files are skipped with a warning. Re-read on each call so new files show up live. */
export function loadPacks(dir = PACKS_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const packs = [];
  for (const file of files.sort()) {
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const problems = validatePack(pack);
      if (problems.length) {
        console.warn(`[packs] skipping ${file}: ${problems.join("; ")}`);
        continue;
      }
      packs.push({ file, topic: pack.topic.trim(), description: pack.description || "", questions: pack.questions });
    } catch (err) {
      console.warn(`[packs] skipping ${file}: ${err.message}`);
    }
  }
  return packs;
}

let cache = { at: 0, packs: [] };
/** Cached for a few seconds so lobby updates don't hit the disk constantly. */
export function getPacks() {
  if (Date.now() - cache.at > 5000) cache = { at: Date.now(), packs: loadPacks() };
  return cache.packs;
}

export function findPack(topic) {
  const t = String(topic).trim().toLowerCase();
  return getPacks().find((p) => p.topic.toLowerCase() === t) || null;
}

/** Public listing: topic names and sizes only — never the questions. */
export function listPacks() {
  return getPacks().map((p) => ({ topic: p.topic, description: p.description, size: p.questions.length }));
}
