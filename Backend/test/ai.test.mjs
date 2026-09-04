import { test } from "node:test";
import assert from "node:assert/strict";

import { AIError } from "../config/gemini.js";
import {
  normalizeAIProductFields,
  buildProductEmbeddingText,
} from "../services/ai/productText.js";
import {
  buildDescriptionPrompt,
  validateDescriptionOutput,
  generateProductDescription,
} from "../services/ai/description.js";
import { generateQueryEmbedding, shouldRefreshEmbedding } from "../services/ai/embedding.js";
import { computeInterestScores, EVENT_WEIGHTS } from "../services/ai/recommendations.js";

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