// ---------------------------------------------------------------------------
// Seller "Ask AI" description assistant.
// A small chatbot that helps the seller write / polish the product description.
// Every request carries the current product context (fields + optional image)
// plus the recent conversation history, so answers always stay grounded.
// ---------------------------------------------------------------------------

import { AIError, generateText } from "../../config/gemini.js";
import { normalizeAIProductFields } from "./productText.js";

// Build the assistant system prompt from the normalized product fields.
// Exported for unit tests.
export function buildChatSystemPrompt(product) {
  const lines = [
    "You are an AI writing assistant helping a seller craft the product description for their online store.",
    "You only know about THIS product — use ONLY the information below (and the attached image).",
    "Never invent specifications, certifications, warranty, prices, statistics, extra features, or medical claims.",
    "",
    "PRODUCT:",
    `- Name: ${product.name || "Not provided"}`,
    product.brand ? `- Brand: ${product.brand}` : null,
    product.category ? `- Category: ${product.category}` : null,
    product.description ? `- Current description: ${product.description}` : null,
    product.sellingPoints.length ? `- Selling points: ${product.sellingPoints.join(", ")}` : null,
    product.attributes.length
      ? `- Attributes: ${product.attributes.map((a) => `${a.name}: ${a.value}`).join(", ")}`
      : null,
    product.features.length ? `- Features: ${product.features.join(", ")}` : null,
    product.tags.length ? `- Tags: ${product.tags.join(", ")}` : null,
    product.variants.length
      ? `- Variants: ${product.variants.map((v) => (v.label ? `${v.label}${v.sku ? ` (${v.sku})` : ""}` : v.sku)).join(", ")}`
      : null,
    "",
    "RULES:",
    "- Answer the seller's request concisely and directly.",
    "- When the seller asks to write or rewrite the description, respond with ONLY the new description text — no commentary, no markdown headers, no quotes.",
    "- When asked for bullet points or highlights, use a compact \"- item\" list.",
    "- Keep the tone professional, attractive, and e-commerce ready.",
    "- If the request is unrelated to the product or impossible with the given info, say so briefly.",
  ];
  return lines.filter(Boolean).join("\n");
}

// Build the final user turn: optional image first, then the seller's message.
// Exported for unit tests.
export function buildChatParts({ message, image }) {
  const parts = [];
  if (image && typeof image === "object" && image.data && image.mimeType) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }
  parts.push({ text: message });
  return parts;
}

// Generate a reply to the seller's chat message.
// `product` may be a plain object (request body shape) or a Product doc.
// `history` is [{ role: "user" | "assistant", content }] — recent turns only.
// `deps` allows tests to inject a fake Gemini client ({ client }).
export async function generateDescriptionChat({ message, product = {}, history = [], image = null }, deps = {}) {
  if (!message || !String(message).trim()) {
    throw new AIError("Message is required", "AI_INVALID_RESPONSE");
  }

  const normalized = normalizeAIProductFields(product);
  const systemPrompt = buildChatSystemPrompt(normalized);
  const prompt = `${systemPrompt}\n\n---\n\nSeller's message:\n${String(message).trim()}`;

  return generateText({
    prompt,
    parts: buildChatParts({ message: prompt, image }),
    history,
    deps,
    temperature: 0.6,
    maxOutputTokens: 1024,
  });
}