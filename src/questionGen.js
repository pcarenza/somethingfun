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

export const PROVIDERS = {
  claude: { label: "Claude", defaultModel: MODEL },
  gemini: { label: "Gemini", defaultModel: process.env.GEMINI_MODEL || "gemini-2.5-flash" },
};

function buildPrompt(topic, count) {
  return `Write ${count} fun, factually accurate trivia questions about the topic: "${topic}".

Rules:
- Each question is either "multiple_choice" (exactly 4 distinct choices, exactly 1 correct) or "true_false" (choices exactly ["True", "False"]).
- Pick the format that best suits each individual piece of trivia; aim for roughly 70% multiple choice and 30% true/false, mixed in a random order.
- Vary difficulty from easy to challenging, and cover different facets of the topic. No duplicate facts.
- Wrong choices must be plausible but unambiguously wrong. Only include facts you are confident are true.
- Avoid facts that change over time (records, "current" office holders, latest releases).
- Keep each question under 160 characters and each choice under 60 characters. Do not reveal the answer in the question.
- correctIndex is the 0-based index of the correct choice.`;
}

function parseQuestions(text, topic, count) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The model returned something that wasn't valid JSON");
  }
  const questions = (parsed.questions || []).map((q) => normalizeQuestion(q, topic)).filter(Boolean);
  if (questions.length === 0) throw new Error("No valid questions were produced");
  return questions.slice(0, count);
}

async function generateWithClaude(topic, count, { apiKey, model } = {}) {
  const c = apiKey ? new Anthropic({ apiKey }) : getClient();
  if (!c) throw new Error("No Anthropic credentials configured");

  const stream = c.beta.messages.stream({
    model: model || PROVIDERS.claude.defaultModel,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: QUESTION_SCHEMA },
    },
    messages: [{ role: "user", content: buildPrompt(topic, count) }],
  });
  let msg;
  try {
    msg = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Claude rejected the API key");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Claude rate limit hit; try again in a minute");
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API error: ${err.message}`);
    throw err;
  }

  if (msg.stop_reason === "refusal") throw new Error("The model declined this topic");
  const textBlocks = msg.content.filter((b) => b.type === "text");
  const text = textBlocks.length ? textBlocks[textBlocks.length - 1].text : "";
  return parseQuestions(text, topic, count);
}

// Gemini's response schema uses the OpenAPI subset (no additionalProperties).
const GEMINI_SCHEMA = {
  type: "OBJECT",
  required: ["questions"],
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["type", "question", "choices", "correctIndex"],
        properties: {
          type: { type: "STRING", enum: ["multiple_choice", "true_false"] },
          question: { type: "STRING" },
          choices: { type: "ARRAY", items: { type: "STRING" } },
          correctIndex: { type: "INTEGER" },
        },
      },
    },
  },
};

async function generateWithGemini(topic, count, { apiKey, model } = {}) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("No Gemini API key provided");
  const m = encodeURIComponent(model || PROVIDERS.gemini.defaultModel);
  const base = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const res = await fetch(`${base}/v1beta/models/${m}:generateContent`, {
    method: "POST",
    // Key goes in a header, not the URL, so it never shows up in logs.
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt(topic, count) }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA },
    }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && /api key/i.test(msg)) throw new Error("Gemini rejected the API key");
    if (res.status === 429) throw new Error("Gemini rate limit or free-tier quota hit; try again later");
    throw new Error(`Gemini API error: ${msg}`);
  }
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked this topic (${data.promptFeedback.blockReason})`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned an empty response");
  return parseQuestions(text, topic, count);
}

/** Generate questions with the chosen provider. Keys are used for this call only and never stored. */
export async function generateQuestions(provider, topic, count, opts = {}) {
  if (provider === "gemini") return generateWithGemini(topic, count, opts);
  if (provider === "claude") return generateWithClaude(topic, count, opts);
  throw new Error("Unknown provider");
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
    const questions = await generateWithClaude(topic, count);  // live generation uses the server's env key
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
