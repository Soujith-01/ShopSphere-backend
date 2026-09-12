import Product from "../../models/Product.js";
import { generateStructuredJSON, AIError } from "../../config/gemini.js";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// In-memory cache for AI completions, keyed by lowercase query. Autocomplete
// fires per keystroke, so repeated prefixes ("run", "runn", "runni") benefit
// and the same query typed twice is free. Entries expire after 10 minutes.
const AI_CACHE = new Map();
const AI_CACHE_TTL_MS = 10 * 60 * 1000;
const AI_CACHE_MAX = 200;

function cacheGet(key) {
  const hit = AI_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > AI_CACHE_TTL_MS) {
    AI_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (AI_CACHE.size >= AI_CACHE_MAX) {
    const oldest = AI_CACHE.keys().next().value;
    AI_CACHE.delete(oldest);
  }
  AI_CACHE.set(key, { value, at: Date.now() });
}

// Gemini generates natural product search completions for a partial query.
// Returns an array of suggestion strings (capped at `limit`). Long-running —
// never call this in the critical autocomplete path; race it with a timeout.
export async function generateSearchSuggestions({ query, limit = 6, deps = {} }) {
  const q = String(query ?? "").trim().slice(0, 100);
  if (!q) return [];

  const cacheKey = `ai:${q.toLowerCase()}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const result = await generateStructuredJSON({
    prompt: [
      "You generate search autocomplete suggestions for an e-commerce marketplace.",
      `The user is typing: "${q}"`,
      "Suggest realistic product search phrases a shopper might want (e.g. \"wireless earbuds\", \"cotton t-shirt under 500\").",
      `Return exactly ${limit} suggestions, shorter than 40 characters each, sorted by relevance.`,
      "Do not repeat the input verbatim. Use lowercase, plain text, no punctuation.",
    ].join("\n"),
    schema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["suggestions"],
    },
    deps,
  });

  const list = Array.isArray(result?.suggestions) ? result.suggestions : [];
  const suggestions = list
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 60)
    .slice(0, limit);

  if (suggestions.length > 0) cacheSet(cacheKey, suggestions);
  return suggestions;
}

// Instant catalog suggestions from real, active products. Matches the query as
// a prefix of the product name OR of any word in it ("run" → "Nike Running
// Shoes"), ranked by sales so popular products surface first. Runs in
// milliseconds — this is the primary autocomplete source.
export async function productNameSuggestions(query, limit = 6) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const rx = escapeRegex(q);
  const filter = {
    status: "active",
    $or: [
      { name: { $regex: `^${rx}`, $options: "i" } },
      { name: { $regex: `\\b${rx}`, $options: "i" } },
      { brand: { $regex: `^${rx}`, $options: "i" } },
    ],
  };

  const products = await Product.find(filter)
    .sort({ "stats.totalSold": -1, createdAt: -1 })
    .limit(limit * 2)
    .select("name brand")
    .lean();

  // Dedupe names (variants can share a title) and cap.
  const seen = new Set();
  const out = [];
  for (const p of products) {
    if (p.name && !seen.has(p.name)) {
      seen.add(p.name);
      out.push(p.name);
    }
    if (out.length >= limit) break;
  }
  return out;
}

// Merge catalog + AI phrases, case-insensitively deduped, catalog first.
function mergeSuggestions(catalog, ai, limit) {
  const seen = new Set(catalog.map((s) => s.toLowerCase()));
  const merged = [...catalog];
  for (const s of ai) {
    const key = s.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(s);
    }
    if (merged.length >= limit) break;
  }
  return merged.slice(0, limit);
}

// Entry point, tuned for per-keystroke autocomplete:
// 1. Any catalog prefix match → respond INSTANTLY (milliseconds). Cached AI
//    phrases merge in for free; a background call warms the cache so typing
//    gets progressively richer without ever blocking a keystroke.
// 2. Zero catalog matches (e.g. early letters with no product) → give AI a
//    short race to suggest phrases; there's nothing instant to show anyway.
// AI failures never break or slow the API.
const AI_RACE_MS = Number(process.env.GEMINI_SUGGESTION_RACE_MS) || 600;

export async function getSearchSuggestions({ query, limit = 6, deps = {} }) {
  // Primary: instant catalog names.
  let catalog = [];
  try {
    catalog = await productNameSuggestions(query, limit);
  } catch (err) {
    console.error(`[AI] Catalog suggestion lookup failed: ${err.message}`);
  }

  const cacheKey = `ai:${String(query ?? "").trim().toLowerCase()}:${limit}`;
  const cachedAi = cacheGet(cacheKey) || [];

  if (catalog.length > 0) {
    // Fast path: real products to show — never wait on AI.
    if (cachedAi.length === 0) {
      // Warm the AI cache in the background; later keystrokes/retypes enrich.
      generateSearchSuggestions({ query, limit, deps })
        .then((list) => { if (list.length > 0) cacheSet(cacheKey, list); })
        .catch(() => { /* best-effort cache warming */ });
    }
    return mergeSuggestions(catalog, cachedAi, limit);
  }

  // Empty catalog: try cached AI first, then a short live race.
  let ai = cachedAi;
  if (ai.length === 0) {
    try {
      ai = await Promise.race([
        generateSearchSuggestions({ query, limit, deps }),
        new Promise((resolve) => setTimeout(() => resolve([]), AI_RACE_MS)),
      ]);
    } catch (err) {
      if (err instanceof AIError) {
        console.error(`[AI] Suggestion generation failed (${err.code}) — empty response`);
      } else {
        console.error(`[AI] Suggestion generation failed: ${err.message} — empty response`);
      }
    }
  }
  return mergeSuggestions(catalog, ai, limit);
}
