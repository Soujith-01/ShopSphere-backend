import { generateStructuredJSON, AIError } from "../../config/gemini.js";
import { searchProducts } from "./search.js";

/**
 * Parse a natural language product query into structured filters.
 * Gemini converts phrases like "headphones for gaming under 3000 with microphone"
 * into: { keywords: "headphones", category: "Headphones", maxPrice: 3000,
 *          features: ["microphone"], purpose: "gaming" }
 *
 * The function NEVER invents products — it only returns filters that are
 * applied against the actual product database via searchProducts().
 */

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "string",
      description:
        "Core search keywords extracted from the query (e.g. 'headphones', 'running shoes'). Keep it short — 2-4 words max.",
    },
    category: {
      type: "string",
      description:
        "Product category if mentioned or clearly implied (e.g. 'Headphones', 'Electronics', 'Shoes'). Null if unclear.",
    },
    brand: {
      type: "string",
      description:
        "Brand name if mentioned (e.g. 'Nike', 'Sony'). Null if not mentioned.",
    },
    minPrice: {
      type: "number",
      description: "Minimum price in INR. Null if not specified.",
    },
    maxPrice: {
      type: "number",
      description: "Maximum price in INR. Null if not specified.",
    },
    features: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific features or attributes requested (e.g. 'microphone', 'wireless', 'lightweight'). Empty array if none.",
    },
    purpose: {
      type: "string",
      description:
        "Intended use case or context (e.g. 'gaming', 'running', 'office'). Null if not mentioned.",
    },
    sort: {
      type: "string",
      enum: ["newest", "popular", "price_asc", "price_desc", "rating"],
      description: "Sort preference if implied (e.g. 'best' → rating, 'cheapest' → price_asc). Default: popular.",
    },
  },
  required: ["keywords"],
};

/**
 * Parse a natural language query into search filters using Gemini.
 * Falls back to simple keyword extraction if AI is unavailable.
 */
export async function parseNaturalQuery({ query, deps = {} }) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) {
    throw new AIError("Search query is required", "AI_INVALID_RESPONSE");
  }

  // If Gemini is available, use it to parse the query intelligently
  try {
    const parsed = await generateStructuredJSON({
      prompt: [
        "You are a search filter parser for an Indian e-commerce marketplace.",
        'A customer types a natural language search query. Extract structured filters from it.',
        "The marketplace sells: Electronics, Clothing, Shoes, Accessories, Home & Kitchen, Sports, Beauty, Books, Toys, Grocery.",
        "Common Indian context: prices are in INR (₹), brands like Boat, Noise, Nike, Samsung are common.",
        "",
        "Query: " + trimmed,
        "",
        "Return ONLY the JSON object with extracted filters. Use null for unspecified fields.",
        "For keywords, extract the core product name — ignore filler words like 'I need', 'show me', 'find'.",
        "If someone says 'under 3000', that means maxPrice: 3000.",
        "If someone says 'above 500', that means minPrice: 500.",
        "If someone says 'good for gaming', set purpose: 'gaming'.",
        "If someone says 'with microphone', add 'microphone' to features.",
      ].join("\n"),
      schema: SEARCH_SCHEMA,
      deps,
    });

    return parsed;
  } catch (err) {
    // AI unavailable — fall back to simple keyword extraction
    console.error(
      `[AI] Natural query parsing failed (${err.code || err.message}) — using keyword fallback`
    );
    return simpleParseQuery(trimmed);
  }
}

/**
 * Simple keyword-based parser (fallback when Gemini is unavailable).
 * Extracts price mentions and passes everything else as a keyword search.
 */
export function simpleParseQuery(query) {
  const result = {
    keywords: query,
    category: null,
    brand: null,
    minPrice: null,
    maxPrice: null,
    features: [],
    purpose: null,
    sort: "popular",
  };

  // Extract price patterns: "under 3000", "below 2000", "above 500", "₹1500"
  const underMatch = query.match(/(?:under|below|less than|upto|up to)\s*(?:₹?\s*)?(\d[\d,]*)/i);
  if (underMatch) {
    result.maxPrice = Number(underMatch[1].replace(/,/g, ""));
  }

  const aboveMatch = query.match(/(?:above|over|more than|from|starting)\s*(?:₹?\s*)?(\d[\d,]*)/i);
  if (aboveMatch) {
    result.minPrice = Number(aboveMatch[1].replace(/,/g, ""));
  }

  // Extract ₹ symbol price: "₹3000" or "Rs 3000"
  if (!result.maxPrice && !result.minPrice) {
    const priceMatch = query.match(/(?:₹|Rs\.?|INR)\s*(\d[\d,]*)/i);
    if (priceMatch) {
      result.maxPrice = Number(priceMatch[1].replace(/,/g, ""));
    }
  }

  // Clean up keywords: remove price mentions and filler words
  let keywords = query
    .replace(/(?:under|below|less than|upto|up to|above|over|more than|from|starting)\s*(?:₹?\s*)?\d[\d,]*/gi, "")
    .replace(/(?:₹|Rs\.?|INR)\s*\d[\d,]*/gi, "")
    .replace(/\b(I need|show me|find|search for|looking for|want|buy|get me|please)\b/gi, "")
    .replace(/\b(with|for|that has|having|which has)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  result.keywords = keywords || query;

  return result;
}

/**
 * Execute a natural language search: parse → build filters → search DB.
 * Returns { products, pagination, searchMode, parsedQuery }.
 */
export async function naturalSearch({ query, page = 1, limit = 20, deps = {} }) {
  const parsed = await parseNaturalQuery({ query, deps });

  // Build the filter object for the existing searchProducts function
  const filters = {};

  if (parsed.category) {
    // We'll pass category as a text filter — searchProducts handles it
    // If it's a valid ObjectId, use it directly; otherwise it's a text match
    filters._categoryName = parsed.category;
  }

  if (parsed.brand) {
    filters.brand = parsed.brand;
  }

  if (parsed.minPrice !== null && parsed.minPrice !== undefined) {
    filters.minPrice = parsed.minPrice;
  }

  if (parsed.maxPrice !== null && parsed.maxPrice !== undefined) {
    filters.maxPrice = parsed.maxPrice;
  }

  // Use the keywords for the main text search
  const searchQuery = parsed.keywords || query;

  // Run the actual product search against the database
  const result = await searchProducts({
    query: searchQuery,
    filters,
    page,
    limit,
    mode: "keyword", // Always use keyword search for natural language — more reliable
    deps,
  });

  // If category was a text name (not ObjectId), do an additional filter
  let products = result.products;
  if (parsed._categoryName && products.length > 0) {
    // Already filtered by keyword search — category text is part of the query
  }

  // Apply feature filtering in-memory (post-search) since features are text-based
  if (parsed.features && parsed.features.length > 0) {
    const lowerFeatures = parsed.features.map((f) => f.toLowerCase());
    products = products.filter((p) => {
      const allText = [
        p.name,
        p.description,
        ...(p.aiSellingPoints || []),
        ...(p.tags || []),
        ...(p.features || []),
        ...(p.attributes || []).map((a) => `${a.name} ${a.value}`),
      ]
        .join(" ")
        .toLowerCase();
      return lowerFeatures.some((f) => allText.includes(f));
    });
  }

  // Apply purpose filtering in-memory (post-search)
  if (parsed.purpose) {
    const lowerPurpose = parsed.purpose.toLowerCase();
    products = products.filter((p) => {
      const allText = [
        p.name,
        p.description,
        ...(p.aiSellingPoints || []),
        ...(p.tags || []),
        ...(p.features || []),
      ]
        .join(" ")
        .toLowerCase();
      return allText.includes(lowerPurpose);
    });
  }

  return {
    products,
    pagination: result.pagination,
    searchMode: result.searchMode,
    parsedQuery: {
      keywords: parsed.keywords,
      category: parsed.category,
      brand: parsed.brand,
      minPrice: parsed.minPrice,
      maxPrice: parsed.maxPrice,
      features: parsed.features,
      purpose: parsed.purpose,
      sort: parsed.sort,
    },
  };
}
