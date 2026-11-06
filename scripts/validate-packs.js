// Validates every question pack in /questions. Exit code 1 if any pack is invalid.
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR, validatePack } from "../src/packs.js";

const files = fs.existsSync(PACKS_DIR) ? fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith(".json")) : [];
let bad = 0;
const topics = new Map();
for (const file of files.sort()) {
  let problems;
  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, file), "utf8"));
    problems = validatePack(pack);
  } catch (err) {
    problems = [`invalid JSON: ${err.message}`];
  }
  const t = pack?.topic?.trim().toLowerCase();
  if (t && topics.has(t)) problems.push(`topic "${pack.topic}" is also used by ${topics.get(t)}`);
  if (t) topics.set(t, file);
  if (problems.length) {
    bad++;
    console.log(`✗ ${file}\n  - ${problems.join("\n  - ")}`);
  } else {
    const mc = pack.questions.filter((q) => q.type === "multiple_choice").length;
    console.log(`✓ ${file}: "${pack.topic}" — ${pack.questions.length} questions (${mc} multiple choice, ${pack.questions.length - mc} true/false)`);
  }
}
if (!files.length) console.log("No packs found in", PACKS_DIR);
process.exit(bad ? 1 : 0);
