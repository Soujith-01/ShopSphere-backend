import Product from "../../models/Product.js";
import Variant from "../../models/Variant.js";
import { generateEmbedding, AIError } from "../../config/gemini.js";
import { normalizeAIProductFields, buildProductEmbeddingText } from "./productText.js";

// ---------------------------------------------------------------------------
// Query embeddings
// ---------------------------------------------------------------------------
export async function generateQueryEmbedding(query, deps = {}) {
  const text = String(query ?? "").trim().slice(0, 1000);
  if (!text) {
    throw new AIError("Search query is empty", "AI_INVALID_RESPONSE");
  }
  return generateEmbedding({ text, deps });
}

// ---------------------------------------------------------------------------
// Product embeddings
// ---------------------------------------------------------------------------
// Loads the product (with variants) and embeds its full searchable text.
export async function generateProductEmbedding(productOrId, deps = {}) {
  const product =
    typeof productOrId === "object"
      ? productOrId
      : await Product.findById(productOrId).populate("category", "name");

  if (!product) {
    throw new AIError("Product not found", "AI_INVALID_RESPONSE");
  }

  let variants = [];
  if (product.hasVariants) {
    variants = await Variant.find({ product: product._id, isActive: true })
      .select("label sku options")
      .lean();
  }

  const doc = product.toObject ? product.toObject() : product;
  const normalized = normalizeAIProductFields({ ...doc, variants });
  const text = buildProductEmbeddingText(normalized);

  if (!text.trim()) {
    throw new AIError("Product has no searchable text", "AI_INVALID_RESPONSE");
  }

  return generateEmbedding({ text, deps });
}

// ---------------------------------------------------------------------------
// Change detection — only regenerate when searchable info changes
// ---------------------------------------------------------------------------
export const SEARCHABLE_FIELDS = [
  "name",
  "description",
  "tags",
  "attributes",
  "variantOptions",
  "category",
  "subCategory",
  "price",
  "discount",
  "status",
];

// modifiedPaths: result of doc.modifiedPaths() or an array of changed top-level paths
export function shouldRefreshEmbedding(modifiedPaths = []) {
  return modifiedPaths.some((p) =>
    SEARCHABLE_FIELDS.some((f) => p === f || p.startsWith(`${f}.`))
  );
}

// Regenerate + persist a product's embedding.
// silent=true (default) swallows failures so AI issues never break the request.
export async function refreshProductEmbedding(productId, { silent = true } = {}) {
  const run = async () => {
    const product = await Product.findById(productId).populate("category", "name");
    if (!product) return;
    const embedding = await generateProductEmbedding(product);
    product.aiEmbedding = embedding;
    await product.save({ validateModifiedOnly: true });
    return product;
  };

  if (silent) {
    return run().catch((err) =>
      console.error(`[AI] Embedding refresh failed for product ${productId}: ${err.message}`)
    );
  }
  return run();
}