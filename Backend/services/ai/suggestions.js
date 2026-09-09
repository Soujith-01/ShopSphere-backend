import Product from "../../models/Product.js";
import { generateStructuredJSON, AIError } from "../../config/gemini.js";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Gemini generates natural product search completions for a partial query.
// Returns an array of suggestion strings (capped at `limit`).
export async function generateSearchSuggestions({ query, limit = 6, deps = {} }) {
  const q = String(query ?? "").trim().slice(0, 100);
  if (!q) return [];

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
  return list
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 60)
    .slice(0, limit);
}

// Offline fallback: suggest real, in-stock product names that match the prefix.
// Keeps autocomplete functional even when the Gemini key is missing or slow.
export async function productNameSuggestions(query, limit = 6) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const filter = {
    status: "active",
    name: { $regex: escapeRegex(q), $options: "i" },
  };

  const products = await Product.find(filter)
    .sort({ "stats.totalSold": -1, createdAt: -1 })
    .limit(limit)
    .select("name")
    .lean();

  return products.map((p) => p.name).filter(Boolean);
}

// Entry point: Gemini first, graceful fallback to catalog names. AI failures
// must never break the API.
export async function getSearchSuggestions({ query, limit = 6, deps = {} }) {
  try {
    const ai = await generateSearchSuggestions({ query, limit, deps });
    if (ai.length > 0) return ai;
  } catch (err) {
    if (err instanceof AIError) {
      console.error(`[AI] Suggestion generation failed (${err.code}): ${err.message} — falling back to catalog names`);
    } else {
      console.error(`[AI] Suggestion generation failed: ${err.message} — falling back to catalog names`);
    }
  }
  return productNameSuggestions(query, limit);
}