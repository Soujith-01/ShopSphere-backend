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
  textModel: process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-2.0-flash",
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
// Structured JSON generation (product description + selling points)
// ---------------------------------------------------------------------------
export async function generateStructuredJSON({ prompt, schema, deps = {} }) {
  const { textModel, textTimeoutMs } = getGeminiConfig();
  const client = deps.client || getGeminiClient();

  let response;
  try {
    response = await withTimeout(
      client.models.generateContent({
        model: textModel,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.4,
          maxOutputTokens: 1024,
        },
      }),
      textTimeoutMs,
      "Gemini text request timed out"
    );
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw new AIError(`Gemini API error: ${err.message}`, "AI_API_ERROR");
  }

  const text = typeof response?.text === "string" ? response.text : "";
  if (!text.trim()) {
    throw new AIError("Gemini returned an empty response", "AI_INVALID_RESPONSE");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AIError("Gemini returned invalid JSON", "AI_INVALID_RESPONSE");
  }
  return parsed;
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