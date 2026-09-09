import { generateStructuredJSON, AIError } from "../../config/gemini.js";

// JSON schema enforced on the Gemini response (structured output)
const DESCRIPTION_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    sellingPoints: { type: "array", items: { type: "string" } },
  },
  required: ["description", "sellingPoints"],
};

// Build the prompt. Rules: use ONLY supplied info, never invent facts.
export function buildDescriptionPrompt({ name, brand, category, attributes, features, hasImage = false }) {
  const lines = [
    "You are an e-commerce copywriter. Write a product description and selling points.",
    "",
    "PRODUCT INFORMATION:",
    `- Name: ${name || "Unknown"}`,
    brand ? `- Brand: ${brand}` : null,
    category ? `- Category: ${category}` : null,
  ].filter(Boolean);

  if (hasImage) {
    lines.push(
      "- A product image is attached above. You may describe clearly visible details from it",
      "  (colors, shape, materials, visible features) — but still never invent facts."
    );
  }

  const attrList = Array.isArray(attributes) ? attributes : [];
  if (attrList.length) {
    lines.push(`- Attributes: ${attrList.map((a) => `${a.name}: ${a.value}`).join(", ")}`);
  }

  if (Array.isArray(features) && features.length) {
    lines.push(`- Features: ${features.join(", ")}`);
  }

  lines.push(
    "",
    "RULES:",
    "- Use ONLY the supplied product information above.",
    "- Do NOT invent specifications, certifications, warranty, price, statistics, extra features, or medical claims.",
    "- Write one professional, concise, benefit-oriented description (2-4 sentences).",
    "- Generate exactly 4 to 6 concise selling points as short phrases.",
    "",
    "Respond ONLY with valid JSON:",
    '{"description": "<the description>", "sellingPoints": ["point 1", "point 2", ...]}'
  );

  return lines.join("\n");
}

// Build the Gemini request parts for a prompt + optional product image.
// The image goes first so Gemini sees it as the subject of the prompt.
export function buildDescriptionParts({ prompt, image }) {
  const parts = [];
  if (image && typeof image === "object" && image.data && image.mimeType) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }
  parts.push({ text: prompt });
  return parts;
}

// Validate the parsed Gemini output; throws AIError if malformed.
export function validateDescriptionOutput(raw) {
  if (!raw || typeof raw !== "object") {
    throw new AIError("Gemini response is not an object", "AI_INVALID_RESPONSE");
  }
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const sellingPoints = Array.isArray(raw.sellingPoints)
    ? raw.sellingPoints.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
    : [];

  if (!description) {
    throw new AIError("Gemini response missing 'description'", "AI_INVALID_RESPONSE");
  }
  if (sellingPoints.length < 1) {
    throw new AIError("Gemini response missing 'sellingPoints'", "AI_INVALID_RESPONSE");
  }

  // Dedupe + cap at 6
  return {
    description,
    sellingPoints: [...new Set(sellingPoints)].slice(0, 6),
  };
}

// Generate description + selling points for structured product data.
// `input.image` (optional) is { mimeType, data: base64 } from fetchImageAsBase64.
// `deps` allows tests to inject a fake Gemini client ({ client }).
export async function generateProductDescription(input, deps = {}) {
  if (!input || typeof input !== "object") {
    throw new AIError("Product data is required", "AI_INVALID_RESPONSE");
  }

  const { name, brand = "", category = "", attributes = [], features = [], image = null } = input;
  if (!name || !String(name).trim()) {
    throw new AIError("Product name is required", "AI_INVALID_RESPONSE");
  }

  const hasImage = Boolean(image && image.data && image.mimeType);
  const prompt = buildDescriptionPrompt({ name, brand, category, attributes, features, hasImage });
  const parts = buildDescriptionParts({ prompt, image });
  const raw = await generateStructuredJSON({ prompt, parts, schema: DESCRIPTION_SCHEMA, deps });
  return validateDescriptionOutput(raw);
}