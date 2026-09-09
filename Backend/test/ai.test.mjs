import { test } from "node:test";
import assert from "node:assert/strict";

import { AIError, generateText, generateStructuredJSON } from "../config/gemini.js";
import {
  normalizeAIProductFields,
  buildProductEmbeddingText,
} from "../services/ai/productText.js";
import {
  buildDescriptionPrompt,
  buildDescriptionParts,
  validateDescriptionOutput,
  generateProductDescription,
} from "../services/ai/description.js";
import { buildChatSystemPrompt, buildChatParts, generateDescriptionChat } from "../services/ai/chat.js";
import { fetchImageAsBase64 } from "../services/ai/image.js";
import { generateQueryEmbedding, shouldRefreshEmbedding } from "../services/ai/embedding.js";
import { computeInterestScores, EVENT_WEIGHTS } from "../services/ai/recommendations.js";
import { parseNaturalQuery, simpleParseQuery } from "../services/ai/naturalSearch.js";

// ---------------------------------------------------------------------------
// Fake Gemini client — mocked, no real API calls
// ---------------------------------------------------------------------------
const makeFakeClient = ({ text = null, embedding = [0.1, 0.2, 0.3], textError = null } = {}) => ({
  models: {
    async generateContent() {
      if (textError) throw textError;
      return { text };
    },
    async embedContent() {
      return { embeddings: [{ values: embedding }] };
    },
  },
});

// ---------------------------------------------------------------------------
// productText — normalization + embedding text
// ---------------------------------------------------------------------------
test("normalizeAIProductFields handles request-body shape", () => {
  const out = normalizeAIProductFields({
    name: "Running Shoes",
    brand: "Nike",
    category: "Sports",
    attributes: { color: "Black", material: "Mesh" },
    features: ["Lightweight", "Breathable"],
  });
  assert.equal(out.name, "Running Shoes");
  assert.equal(out.brand, "Nike");
  assert.equal(out.category, "Sports");
  assert.deepEqual(out.attributes, [
    { name: "color", value: "Black" },
    { name: "material", value: "Mesh" },
  ]);
  assert.deepEqual(out.features, ["Lightweight", "Breathable"]);
});

test("normalizeAIProductFields handles a Product mongoose doc (attributes array + populated category + brand from attributes)", () => {
  const out = normalizeAIProductFields({
    name: "Wireless Mouse",
    description: "Ergonomic",
    aiSellingPoints: ["Quiet clicks"],
    attributes: [{ name: "brand", value: "Logitech" }, { name: "color", value: "Black" }],
    tags: ["electronics"],
    category: { name: "Computers" },
    variants: [{ label: "Black", sku: "WM-BLK" }],
  });
  assert.equal(out.brand, "Logitech"); // from attributes
  assert.equal(out.category, "Computers"); // populated doc
  assert.equal(out.description, "Ergonomic");
  assert.deepEqual(out.sellingPoints, ["Quiet clicks"]);
  assert.deepEqual(out.tags, ["electronics"]);
  assert.equal(out.variants.length, 1);
});

test("buildProductEmbeddingText includes all searchable sections", () => {
  const text = buildProductEmbeddingText({
    name: "Running Shoes",
    brand: "Nike",
    category: "Sports",
    description: "Comfortable shoes",
    sellingPoints: ["Lightweight"],
    attributes: [{ name: "material", value: "Mesh" }],
    features: ["Breathable"],
    tags: ["sneakers"],
    variants: [{ label: "UK 9", sku: "NS-9" }],
  });
  assert.match(text, /Running Shoes/);
  assert.match(text, /Nike/);
  assert.match(text, /Sports/);
  assert.match(text, /Comfortable shoes/);
  assert.match(text, /Lightweight/);
  assert.match(text, /material: Mesh/);
  assert.match(text, /Breathable/);
  assert.match(text, /sneakers/);
  assert.match(text, /UK 9 \(NS-9\)/);
});

test("buildProductEmbeddingText handles empty input without throwing", () => {
  assert.equal(buildProductEmbeddingText(null), "");
  assert.equal(buildProductEmbeddingText({}), "");
});

// ---------------------------------------------------------------------------
// description — prompt rules + validation
// ---------------------------------------------------------------------------
test("buildDescriptionPrompt contains the no-invention rules and JSON instruction", () => {
  const prompt = buildDescriptionPrompt({
    name: "Shoes",
    brand: "Nike",
    category: "Sports",
    attributes: [{ name: "color", value: "Black" }],
    features: ["Lightweight"],
  });
  assert.match(prompt, /Use ONLY the supplied product information/);
  assert.match(prompt, /Do NOT invent specifications/);
  assert.match(prompt, /sellingPoints/);
  assert.match(prompt, /Nike/);
});

test("validateDescriptionOutput returns clean description + selling points", () => {
  const out = validateDescriptionOutput({
    description: "  Great shoes  ",
    sellingPoints: [" Lightweight ", "Breathable", "Lightweight"],
  });
  assert.equal(out.description, "Great shoes");
  assert.deepEqual(out.sellingPoints, ["Lightweight", "Breathable"]); // deduped
});

test("validateDescriptionOutput rejects missing fields", () => {
  assert.throws(() => validateDescriptionOutput({ sellingPoints: ["x"] }), AIError);
  assert.throws(() => validateDescriptionOutput({ description: "x" }), AIError);
  assert.throws(() => validateDescriptionOutput("nope"), AIError);
  assert.throws(() => validateDescriptionOutput(null), AIError);
});

test("validateDescriptionOutput caps selling points at 6", () => {
  const out = validateDescriptionOutput({
    description: "d",
    sellingPoints: ["1", "2", "3", "4", "5", "6", "7", "8"],
  });
  assert.equal(out.sellingPoints.length, 6);
});

test("generateProductDescription works with a mocked Gemini client", async () => {
  const client = makeFakeClient({
    text: JSON.stringify({
      description: "Comfortable running shoes.",
      sellingPoints: ["Lightweight", "Breathable", "Cushioned sole", "Durable grip"],
    }),
  });
  const out = await generateProductDescription(
    { name: "Running Shoes", brand: "Nike", category: "Sports", features: ["Lightweight"] },
    { client }
  );
  assert.equal(out.description, "Comfortable running shoes.");
  assert.equal(out.sellingPoints.length, 4);
});

test("generateProductDescription throws AIError on invalid JSON", async () => {
  const client = makeFakeClient({ text: "not json at all" });
  await assert.rejects(
    () => generateProductDescription({ name: "Shoes" }, { client }),
    (err) => err instanceof AIError && err.code === "AI_INVALID_RESPONSE"
  );
});

test("generateProductDescription requires a name", async () => {
  await assert.rejects(
    () => generateProductDescription({ brand: "Nike" }, { client: makeFakeClient() }),
    (err) => err instanceof AIError
  );
});

test("generateProductDescription propagates API errors as AIError", async () => {
  const client = makeFakeClient({ textError: new Error("quota exceeded") });
  await assert.rejects(
    () => generateProductDescription({ name: "Shoes" }, { client }),
    (err) => err instanceof AIError && err.code === "AI_API_ERROR"
  );
});

test("buildDescriptionParts puts the image first then the text part", () => {
  const parts = buildDescriptionParts({
    prompt: "Write a description",
    image: { mimeType: "image/jpeg", data: "aGVsbG8=" },
  });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" } });
  assert.deepEqual(parts[1], { text: "Write a description" });
});

test("buildDescriptionParts omits the image part when none is given", () => {
  const parts = buildDescriptionParts({ prompt: "Write a description", image: null });
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], { text: "Write a description" });
});

test("generateProductDescription with an image still yields clean output", async () => {
  const client = makeFakeClient({
    text: JSON.stringify({ description: "Nice black mouse.", sellingPoints: ["Ergonomic"] }),
  });
  const out = await generateProductDescription(
    { name: "Mouse", image: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
    { client }
  );
  assert.equal(out.description, "Nice black mouse.");
  assert.deepEqual(out.sellingPoints, ["Ergonomic"]);
});

// ---------------------------------------------------------------------------
// description chat (Ask-AI assistant)
// ---------------------------------------------------------------------------
test("buildChatSystemPrompt includes product fields and no-invention rules", () => {
  const prompt = buildChatSystemPrompt({
    name: "Running Shoes",
    brand: "Nike",
    category: "Sports",
    description: "Comfortable",
    sellingPoints: ["Lightweight"],
    attributes: [{ name: "color", value: "Black" }],
    features: ["Breathable"],
    tags: ["sneakers"],
    variants: [{ label: "UK 9", sku: "NS-9" }],
  });
  assert.match(prompt, /Running Shoes/);
  assert.match(prompt, /Nike/);
  assert.match(prompt, /Never invent specifications/);
  assert.match(prompt, /Lightweight/);
  assert.match(prompt, /UK 9 \(NS-9\)/);
});

test("buildChatParts puts the image before the message text", () => {
  const parts = buildChatParts({
    message: "Make it shorter",
    image: { mimeType: "image/png", data: "aW1n" },
  });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { inlineData: { mimeType: "image/png", data: "aW1n" } });
  assert.deepEqual(parts[1], { text: "Make it shorter" });
});

test("generateDescriptionChat returns the model text with a mocked client", async () => {
  const client = makeFakeClient({ text: "Shorter description here." });
  const reply = await generateDescriptionChat(
    { message: "Make this description shorter", product: { name: "Shoes" }, history: [{ role: "user", content: "hi" }] },
    { client }
  );
  assert.equal(reply, "Shorter description here.");
});

test("generateDescriptionChat requires a message", async () => {
  await assert.rejects(
    () => generateDescriptionChat({ message: "   " }, { client: makeFakeClient() }),
    (err) => err instanceof AIError
  );
});

test("generateDescriptionChat propagates upstream errors as AIError", async () => {
  const client = makeFakeClient({ textError: new Error("boom") });
  await assert.rejects(
    () => generateDescriptionChat({ message: "Shorter please", product: { name: "Shoes" } }, { client }),
    (err) => err instanceof AIError && err.code === "AI_API_ERROR"
  );
});

test("generateText retries once on a transient 503 and succeeds", async () => {
  let calls = 0;
  const client = {
    models: {
      async generateContent() {
        calls++;
        if (calls === 1) throw new Error('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}');
        return { text: "Retried OK." };
      },
    },
  };
  const reply = await generateText({ prompt: "hi", deps: { client } });
  assert.equal(reply, "Retried OK.");
  assert.equal(calls, 2);
});

test("generateText maps exhausted transient errors to a friendly AI_BUSY message", async () => {
  const client = {
    models: {
      async generateContent() {
        throw new Error('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}');
      },
    },
  };
  await assert.rejects(
    () => generateText({ prompt: "hi", deps: { client } }),
    (err) => err instanceof AIError && err.code === "AI_BUSY" && /busy/.test(err.message)
  );
});

test("generateStructuredJSON parses JSON with raw newlines inside string values", async () => {
  // Models sometimes emit real newlines inside string values, which is not
  // valid JSON. The parser must escape them before JSON.parse.
  const client = makeFakeClient({
    text: '{\n  "description": "Line one\nLine two of the description.",\n  "sellingPoints": ["A", "B"]\n}',
  });
  const out = await generateStructuredJSON({ prompt: "x", schema: {}, deps: { client } });
  assert.equal(out.description, "Line one\nLine two of the description.");
  assert.deepEqual(out.sellingPoints, ["A", "B"]);
});

test("generateStructuredJSON parses JSON wrapped in markdown code fences", async () => {
  const client = makeFakeClient({
    text: '```json\n{"description": "Great.", "sellingPoints": ["X"]}\n```',
  });
  const out = await generateStructuredJSON({ prompt: "x", schema: {}, deps: { client } });
  assert.equal(out.description, "Great.");
  assert.deepEqual(out.sellingPoints, ["X"]);
});

test("generateText does not retry non-transient errors (single call, AI_API_ERROR)", async () => {
  let calls = 0;
  const client = {
    models: {
      async generateContent() {
        calls++;
        throw new Error("quota exceeded");
      },
    },
  };
  await assert.rejects(
    () => generateText({ prompt: "hi", deps: { client } }),
    (err) => err instanceof AIError && err.code === "AI_API_ERROR"
  );
  assert.equal(calls, 1);
});

test("fetchImageAsBase64 returns null for missing / non-http URLs without throwing", async () => {
  assert.equal(await fetchImageAsBase64(null), null);
  assert.equal(await fetchImageAsBase64(""), null);
  assert.equal(await fetchImageAsBase64("ftp://example.com/img.jpg"), null);
  assert.equal(await fetchImageAsBase64("javascript:alert(1)"), null);
});

test("generateDescriptionChat sends history turns to the client in order", async () => {
  let seenContents = null;
  const client = {
    models: {
      async generateContent({ contents }) {
        seenContents = contents;
        return { text: "OK." };
      },
    },
  };
  await generateDescriptionChat(
    {
      message: "Now shorter",
      product: { name: "Shoes" },
      history: [
        { role: "user", content: "Write a description" },
        { role: "assistant", content: "Great shoes." },
      ],
    },
    { client }
  );
  assert.equal(seenContents.length, 3);
  assert.equal(seenContents[0].role, "user");
  assert.equal(seenContents[1].role, "model"); // assistant → model
  assert.equal(seenContents[2].role, "user");
});

// ---------------------------------------------------------------------------
// embedding
// ---------------------------------------------------------------------------
test("generateQueryEmbedding returns values from mocked client", async () => {
  const values = await generateQueryEmbedding("comfortable running shoes", {
    client: makeFakeClient(),
  });
  assert.deepEqual(values, [0.1, 0.2, 0.3]);
});

test("generateQueryEmbedding rejects empty queries", async () => {
  await assert.rejects(
    () => generateQueryEmbedding("   "),
    (err) => err instanceof AIError
  );
});

test("shouldRefreshEmbedding only fires for searchable fields", () => {
  assert.equal(shouldRefreshEmbedding(["name"]), true);
  assert.equal(shouldRefreshEmbedding(["description"]), true);
  assert.equal(shouldRefreshEmbedding(["attributes"]), true);
  assert.equal(shouldRefreshEmbedding(["tags.0"]), true);
  assert.equal(shouldRefreshEmbedding(["discount.value"]), true);
  assert.equal(shouldRefreshEmbedding(["status"]), true);
  assert.equal(shouldRefreshEmbedding(["images"]), false);
  assert.equal(shouldRefreshEmbedding(["shipping.weight"]), false);
  assert.equal(shouldRefreshEmbedding([]), false);
});

// ---------------------------------------------------------------------------
// recommendations — interest scoring
// ---------------------------------------------------------------------------
test("computeInterestScores applies configured event weights and sorts desc", () => {
  const events = [
    { productId: "a", eventType: "VIEW" },
    { productId: "a", eventType: "PURCHASE" },
    { productId: "b", eventType: "CLICK" },
    { productId: "c", eventType: "WISHLIST" },
  ];
  const scores = computeInterestScores(events);
  assert.deepEqual(scores, [
    ["a", EVENT_WEIGHTS.VIEW + EVENT_WEIGHTS.PURCHASE],
    ["c", EVENT_WEIGHTS.WISHLIST],
    ["b", EVENT_WEIGHTS.CLICK],
  ]);
});

test("computeInterestScores ignores events without a productId and allows custom weights", () => {
  const scores = computeInterestScores(
    [{ eventType: "VIEW" }, { productId: "x", eventType: "VIEW" }],
    { weights: { VIEW: 10 } }
  );
  assert.deepEqual(scores, [["x", 10]]);
});

// ---------------------------------------------------------------------------
// natural search — query parsing + fallback
// ---------------------------------------------------------------------------
test("parseNaturalQuery delegates to Gemini and returns structured filters", async () => {
  const client = makeFakeClient({
    text: JSON.stringify({
      keywords: "headphones",
      category: "Electronics",
      maxPrice: 3000,
      features: ["microphone"],
      purpose: "gaming",
    }),
  });
  const result = await parseNaturalQuery({ query: "headphones for gaming under 3000 with microphone", deps: { client } });
  assert.equal(result.keywords, "headphones");
  assert.equal(result.category, "Electronics");
  assert.equal(result.maxPrice, 3000);
  assert.deepEqual(result.features, ["microphone"]);
  assert.equal(result.purpose, "gaming");
});

test("parseNaturalQuery rejects empty queries", async () => {
  await assert.rejects(
    () => parseNaturalQuery({ query: "" }),
    (err) => err instanceof AIError
  );
  await assert.rejects(
    () => parseNaturalQuery({ query: "   " }),
    (err) => err instanceof AIError
  );
});

test("simpleParseQuery extracts maxPrice from 'under 3000'", () => {
  const r = simpleParseQuery("headphones under 3000");
  assert.equal(r.maxPrice, 3000);
  assert.match(r.keywords, /headphones/);
});

test("simpleParseQuery extracts minPrice from 'above 500'", () => {
  const r = simpleParseQuery("phone cases above 500");
  assert.equal(r.minPrice, 500);
});

test("simpleParseQuery extracts ₹ price", () => {
  const r = simpleParseQuery("shoes under ₹2000");
  assert.equal(r.maxPrice, 2000);
});

test("simpleParseQuery removes filler words from keywords", () => {
  const r = simpleParseQuery("I need wireless headphones for gaming");
  assert.ok(r.keywords.length < "I need wireless headphones for gaming".length);
  assert.match(r.keywords, /wireless headphones/);
});

test("simpleParseQuery handles plain queries without prices", () => {
  const r = simpleParseQuery("running shoes with good grip");
  assert.equal(r.maxPrice, null);
  assert.equal(r.minPrice, null);
  assert.match(r.keywords, /running shoes/);
});