// Builds trivia question sets for a topic.
// Uses Claude when an API key / credential is available; otherwise falls back to
// a small built-in general-knowledge bank so the game is still playable offline.
import Anthropic from "@anthropic-ai/sdk";
import { FALLBACK_BANK } from "./fallbackBank.js";
import { findPack } from "./packs.js";

const MODEL = process.env.TRIVIA_MODEL || "claude-opus-5-5";

const QUESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "question", "choices", "correctIndex"],
        properties: {
          type: { type: "string", enum: ["multiple_choice", "true_false"] },
          question: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          correctIndex: { type: "integer" },
        },
      },
    },
  },
};

/** True when some Anthropic credential is configured in the environment. */
export function aiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client = null;
function getClient() {
  if (client) return client;
  try {
    client = new Anthropic();
    return client;
  } catch {
    return null; // no credentials configured
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Validate + normalise a raw question. Multiple-choice answers are shuffled so the
 * correct answer's position is random. True/false keeps the fixed True, False order.
 * Returns null when the question is malformed.
 */
export function normalizeQuestion(raw, topic) {
  if (!raw || typeof raw.question !== "string" || !raw.question.trim()) return null;
  if (!Array.isArray(raw.choices)) return null;
  const choices = raw.choices.map((c) => String(c).trim());
  const idx = raw.correctIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) return null;

  if (raw.type === "true_false") {
    if (choices.length !== 2) return null;
    const correctIsTrue = /^true$/i.test(choices[idx]);
    const correctIsFalse = /^false$/i.test(choices[idx]);
    if (!correctIsTrue && !correctIsFalse) return null;
    return {
      type: "true_false",
      topic,
      question: raw.question.trim(),
      choices: ["True", "False"],
      correctIndex: correctIsTrue ? 0 : 1,
    };
  }

  if (raw.type === "multiple_choice") {
    if (choices.length !== 4 || new Set(choices.map((c) => c.toLowerCase())).size !== 4) return null;
    const correct = choices[idx];
    const shuffled = shuffle(choices);
    return {
      type: "multiple_choice",
      topic,
      question: raw.question.trim(),
      choices: shuffled,
      correctIndex: shuffled.indexOf(correct),
    };
  }
  return null;
}

async function generateWithClaude(topic, count) {
  const c = getClient();
  if (!c) throw new Error("No Anthropic credentials configured");

  const prompt = `Write ${count} fun, factually accurate trivia questions about the topic: "${topic}".

Rules:
- Each question is either "multiple_choice" (exactly 4 distinct choices, exactly 1 correct) or "true_false" (choices exactly ["True", "False"]).
- Pick the format that best suits each individual piece of trivia; aim for roughly 70% multiple choice and 30% true/false, mixed in a random order.
- Vary difficulty from easy to challenging, and cover different facets of the topic. No duplicate facts.
- Wrong choices must be plausible but unambiguously wrong. Only include facts you are confident are true.
- Keep each question under 160 characters and each choice under 60 characters. Do not reveal the answer in the question.
- correctIndex is the 0-based index of the correct choice.`;

  const stream = c.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: QUESTION_SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === "refusal") throw new Error("The model declined this topic");
  const textBlocks = msg.content.filter((b) => b.type === "text");
  const text = textBlocks.length ? textBlocks[textBlocks.length - 1].text : "";
  const parsed = JSON.parse(text);
  const questions = (parsed.questions || [])
    .map((q) => normalizeQuestion(q, topic))
    .filter(Boolean);
  if (questions.length === 0) throw new Error("No valid questions were produced");
  return questions.slice(0, count);
}

function generateFromFallback(count, usedTexts) {
  const pool = shuffle(FALLBACK_BANK.filter((q) => !usedTexts.has(q.question)));
  return pool
    .slice(0, count)
    .map((q) => normalizeQuestion(q, "General Knowledge"))
    .filter(Boolean);
}

function generateFromPack(pack, count, usedTexts) {
  const pool = shuffle(pack.questions.filter((q) => !usedTexts.has(q.question)));
  return pool
    .slice(0, count)
    .map((q) => normalizeQuestion(q, pack.topic))
    .filter(Boolean);
}

/**
 * Build a question set for one category.
 * Order of preference: a matching question pack, then Claude, then the general bank.
 * @returns {Promise<{questions: object[], source: "pack"|"ai"|"fallback", error?: string}>}
 */
export async function buildCategory(topic, count, usedTexts = new Set()) {
  const pack = findPack(topic);
  if (pack) {
    const questions = generateFromPack(pack, count, usedTexts);
    return {
      questions,
      source: "pack",
      error: questions.length < count ? `Pack only has ${questions.length} questions` : undefined,
    };
  }
  if (!aiAvailable()) {
    return {
      questions: generateFromFallback(count, usedTexts),
      source: "fallback",
      error: "No question pack with that name and no API key set",
    };
  }
  try {
    const questions = await generateWithClaude(topic, count);
    return { questions, source: "ai" };
  } catch (err) {
    console.warn(`[questionGen] AI generation failed for "${topic}": ${err.message}`);
    return {
      questions: generateFromFallback(count, usedTexts),
      source: "fallback",
      error: err.message,
    };
  }
}
