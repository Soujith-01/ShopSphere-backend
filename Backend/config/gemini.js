import { GoogleGenAI } from "@google/genai";

// ---------------------------------------------------------------------------
// Gemini AI client configuration
// Uses the official @google/genai SDK. All secrets stay server-side.
// ---------------------------------------------------------------------------

export class AIError extends Error {
  constructor(message, code = "AI_ERROR") {
    super(message);
    this.name = "AIError";
    this.code = code;
    this.isAIError = true;
  }
}

let cachedClient = null;

// Read configuration from env. Never expose values beyond this module.
export const getGeminiConfig = () => ({
  apiKey: process.env.GEMINI_API_KEY?.trim() || "",
  textModel: process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-3.6-flash",
  embeddingModel: process.env.GEMINI_EMBEDDING_MODEL?.trim() || "text-embedding-004",
  // Pin the output dimension so the Atlas vector index dimension is exact.
  // text-embedding-004 outputs 768 dims by default, gemini-embedding-001 outputs 3072.
  embeddingDimensions: process.env.GEMINI_EMBEDDING_DIMENSIONS
    ? Number(process.env.GEMINI_EMBEDDING_DIMENSIONS)
    : undefined,
  textTimeoutMs: Number(process.env.GEMINI_TEXT_TIMEOUT_MS) || 20000,
  embeddingTimeoutMs: Number(process.env.GEMINI_EMBEDDING_TIMEOUT_MS) || 15000,
});

export const isGeminiConfigured = () => Boolean(getGeminiConfig().apiKey);

// Lazily-created singleton client
export const getGeminiClient = () => {
  const { apiKey } = getGeminiConfig();
  if (!apiKey) {
    throw new AIError("AI service is not configured (GEMINI_API_KEY missing)", "AI_NOT_CONFIGURED");
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
};

// Race a promise against a timeout so a hung upstream call can never hang a request.
const withTimeout = (promise, ms, message) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AIError(message, "AI_TIMEOUT")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// ---------------------------------------------------------------------------
// Helpers to build multimodal request contents.
// `parts` is an array of Gemini Part objects, e.g.
//   [{ inlineData: { mimeType, data } }, { text: "..." }]
// ---------------------------------------------------------------------------
const toContents = (parts) =>
  Array.isArray(parts) && parts.length > 0 ? [{ role: "user", parts }] : null;

// Normalize a short chat history into Gemini turns (roles: user/model).
// Rows are [{ role: "user" | "assistant", content }] and map to user/model.
export const historyToContents = (history) => {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .slice(-10)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.trim() }],
    }));
};

// ---------------------------------------------------------------------------
// Resilience: model fallback chain + retries.
// Gemini models occasionally return transient 429/500/503 "high demand" errors
// or time out. Instead of failing the request, we try the next model in the
// chain (e.g. gemini-3.6-flash → gemini-3.5-flash → gemini-3.7-flash) and
// retry each model once on transient failures. Bounded to 4 total calls.
// ---------------------------------------------------------------------------

// Primary model from env; extra fallbacks from GEMINI_FALLBACK_MODELS (comma
// separated). Always appends two known-good defaults so a bad primary can't
// take the feature down.
const getModelChain = () => {
  const primary = getGeminiConfig().textModel;
  const extra = (process.env.GEMINI_FALLBACK_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Known-good defaults come first so a dead primary can't take the feature
  // down, and load is spread across models (free-tier quotas are per-model).
  const defaults = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-flash-lite-latest"];
  const chain = [primary];
  for (const m of [...defaults, ...extra]) {
    if (m && !chain.includes(m)) chain.push(m);
  }
  return chain.slice(0, 4); // cap: 4 models, total attempts bounded below
};

// Transient = worth retrying (rate limit / overload / server hiccup / timeout).
// The SDK surfaces the API error as JSON text inside the message, e.g.
// `{"error":{"code":503,"message":"...","status":"UNAVAILABLE"}}`.
const isTransientError = (err) => {
  if (err instanceof AIError && err.code === "AI_TIMEOUT") return true;
  const msg = err?.message || "";
  return /\.code\":(429|500|503)/.test(msg) || /UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL/.test(msg);
};

// Distinguish hard quota exhaustion from transient overload so the user gets
// an actionable message ("check your Gemini plan") instead of "try again".
const isQuotaError = (err) => {
  const msg = err?.message || "";
  return /quota|billing|RESOURCE_EXHAUSTED/.test(msg);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Escape raw newlines/tabs that LLMs sometimes leave inside JSON string values
// (valid JSON requires them escaped). Structural whitespace between tokens is
// left untouched because we only rewrite inside matched string literals.
const escapeControlCharsInStrings = (json) =>
  json.replace(/"((?:[^"\\]|\\.)*)"/g, (m, s) =>
    `"${s.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t")}"`
  );

// Parse the model's text as JSON, tolerating markdown code fences, stray prose
// around the JSON, and raw newlines inside string values. Try progressively
// more forgiving strategies before giving up.
const parseStructuredJSON = (text) => {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  // 1. Strict parse.
  try {
    return JSON.parse(candidate);
  } catch { /* fall through */ }

  // 2. Repair raw control chars inside strings, then retry.
  try {
    return JSON.parse(escapeControlCharsInStrings(candidate));
  } catch { /* fall through */ }

  // 3. Slice the first balanced object/array out of any surrounding prose.
  const first = candidate.indexOf("{") === -1 ? candidate.indexOf("[") : candidate.indexOf("{");
  const last = candidate.lastIndexOf("}") === -1 ? candidate.lastIndexOf("]") : candidate.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const slice = candidate.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {
      try {
        return JSON.parse(escapeControlCharsInStrings(slice));
      } catch { /* fall through */ }
    }
  }

  throw new Error("no JSON found");
};

// Run client.models.generateContent with the model chain + retries.
// `buildRequest(model)` returns the full generateContent payload.
// Tests inject `deps.client` — with a mocked client only the primary model is
// ever used and errors pass through unchanged.
const generateContentWithRetry = async ({ buildRequest, deps }) => {
  const client = deps.client || getGeminiClient();
  const { textTimeoutMs } = getGeminiConfig();
  const chain = deps.client ? [getGeminiConfig().textModel] : getModelChain();
  const MAX_TOTAL_ATTEMPTS = 5;
  let total = 0;
  let lastError = null;

  for (const model of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (total >= MAX_TOTAL_ATTEMPTS) break;
      total++;
      try {
        return await withTimeout(
          client.models.generateContent(buildRequest(model)),
          textTimeoutMs,
          "Gemini text request timed out"
        );
      } catch (err) {
        lastError = err;
        if (!isTransientError(err)) break; // non-transient → next model
        if (attempt < 2) await sleep(600); // brief backoff, then retry same model
      }
    }
    if (total >= MAX_TOTAL_ATTEMPTS) break;
    if (lastError && !isTransientError(lastError)) {
      await sleep(400); // small gap before trying the next model
    }
  }

  // All attempts failed.
  if (isTransientError(lastError)) {
    if (isQuotaError(lastError)) {
      throw new AIError(
        "The AI service quota for this account is exhausted — try again later or check your Gemini plan.",
        "AI_QUOTA"
      );
    }
    throw new AIError(
      "The AI service is busy right now — please try again in a moment.",
      "AI_BUSY"
    );
  }
  if (lastError instanceof AIError) throw lastError;
  throw new AIError(`Gemini API error: ${lastError?.message || "unknown error"}`, "AI_API_ERROR");
};

// ---------------------------------------------------------------------------
// Structured JSON generation (product description + selling points)
// Accepts either a plain text `prompt` or multimodal `parts` (image + text).
// ---------------------------------------------------------------------------
export async function generateStructuredJSON({ prompt, parts, schema, deps = {} }) {
  const contents = toContents(parts) || prompt;

  let response;
  try {
    response = await generateContentWithRetry({
      deps,
      buildRequest: (model) => ({
        model,
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.4,
          maxOutputTokens: 1024,
        },
      }),
    });
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw new AIError(`Gemini API error: ${err.message}`, "AI_API_ERROR");
  }

  const text = typeof response?.text === "string" ? response.text : "";
  if (!text.trim()) {
    throw new AIError("Gemini returned an empty response", "AI_INVALID_RESPONSE");
  }

  try {
    return parseStructuredJSON(text);
  } catch {
    throw new AIError(
      `Gemini returned invalid JSON: ${text.slice(0, 120)}`,
      "AI_INVALID_RESPONSE"
    );
  }
}

// ---------------------------------------------------------------------------
// Free-form text generation (the seller "Ask AI" description assistant).
// `parts` = the final user turn (image + text); `history` = prior turns.
// Returns the trimmed plain-text reply (no JSON schema enforcement).
// ---------------------------------------------------------------------------
export async function generateText({ prompt, parts, history = [], deps = {}, temperature = 0.6, maxOutputTokens = 1024 }) {
  const contents = [
    ...historyToContents(history),
    ...(toContents(parts) || [{ role: "user", parts: [{ text: prompt }] }]),
  ];

  let response;
  try {
    response = await generateContentWithRetry({
      deps,
      buildRequest: (model) => ({
        model,
        contents,
        config: { temperature, maxOutputTokens },
      }),
    });
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw new AIError(`Gemini API error: ${err.message}`, "AI_API_ERROR");
  }

  const text = typeof response?.text === "string" ? response.text.trim() : "";
  if (!text) {
    throw new AIError("Gemini returned an empty response", "AI_INVALID_RESPONSE");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------
export async function generateEmbedding({ text, deps = {} }) {
  const { embeddingModel, embeddingDimensions, embeddingTimeoutMs } = getGeminiConfig();
  const client = deps.client || getGeminiClient();

  const params = {
    model: embeddingModel,
    contents: text,
  };
  if (embeddingDimensions) {
    params.config = { outputDimensionality: embeddingDimensions };
  }

  let response;
  try {
    response = await withTimeout(
      client.models.embedContent(params),
      embeddingTimeoutMs,
      "Gemini embedding request timed out"
    );
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw new AIError(`Gemini embedding API error: ${err.message}`, "AI_API_ERROR");
  }

  const values = response?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new AIError("Gemini returned no embedding values", "AI_INVALID_RESPONSE");
  }
  return values;
}