import Product from "../../models/Product.js";
import Variant from "../../models/Variant.js";
import { generateQueryEmbedding } from "./embedding.js";
import { AIError } from "../../config/gemini.js";

const VECTOR_INDEX_NAME = process.env.ATLAS_VECTOR_INDEX_NAME || "product_embedding_index";
const POPULATE = [
  { path: "category", select: "name slug" },
  { path: "store", select: "name slug logo" },
];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Build the Mongo filter from query params (shared by vector + keyword search).
export async function buildProductFilters({
  category,
  subCategory,
  seller,
  store,
  brand,
  minPrice,
  maxPrice,
  rating,
  availability,
} = {}) {
  const filter = { status: "active" };

  if (category) filter.category = category;
  if (subCategory) filter.subCategory = subCategory;
  if (seller) filter.seller = seller;
  if (store) filter.store = store;

  if (brand) {
    filter.attributes = {
      $elemMatch: {
        name: { $regex: "^brand$", $options: "i" },
        value: { $regex: escapeRegex(brand), $options: "i" },
      },
    };
  }

  if (minPrice !== undefined && minPrice !== "") filter.price = { ...(filter.price || {}), $gte: Number(minPrice) };
  if (maxPrice !== undefined && maxPrice !== "") filter.price = { ...(filter.price || {}), $lte: Number(maxPrice) };

  if (rating) filter["stats.avgRating"] = { $gte: Number(rating) };

  if (availability === "in_stock") {
    const variantProductIds = await Variant.distinct("product", { stock: { $gt: 0 } });
    filter.$or = [{ hasVariants: false }, { _id: { $in: variantProductIds } }];
  }

  return filter;
}

const normalizePagination = (page, limit) => ({
  page: Math.max(1, Number(page) || 1),
  limit: Math.min(100, Math.max(1, Number(limit) || 20)),
});

// Fetch populated docs while preserving vector-search order
const fetchOrderedDocs = async (ids) => {
  if (!ids.length) return [];
  const docs = await Product.find({ _id: { $in: ids } })
    .populate(POPULATE)
    .lean();
  const map = new Map(docs.map((d) => [String(d._id), d]));
  return ids
    .map((id) => map.get(String(id)))
    .filter(Boolean)
    .map((d) => {
      delete d.aiEmbedding;
      return d;
    });
};

// ---------------------------------------------------------------------------
// Semantic search (MongoDB Atlas Vector Search on aiEmbedding)
// ---------------------------------------------------------------------------
export async function semanticSearch({ query, filters = {}, page = 1, limit = 20, deps = {} }) {
  const { page: pageNum, limit: limitNum } = normalizePagination(page, limit);

  const queryVector = await generateQueryEmbedding(query, deps);
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    throw new AIError("Failed to embed search query", "AI_INVALID_RESPONSE");
  }

  const mongoFilter = await buildProductFilters(filters);
  // Only docs with an embedding can match; status filter keeps the catalog clean.
  const vectorFilter = { ...mongoFilter, aiEmbedding: { $exists: true, $ne: [] } };

  // Pre-filtered candidates. Scaled for later pages (skip/limit happen after).
  const numCandidates = Math.min(10000, Math.max(limitNum * (pageNum + 1) * 20, 200));

  const vectorStage = {
    $vectorSearch: {
      index: VECTOR_INDEX_NAME,
      path: "aiEmbedding",
      queryVector,
      numCandidates,
      limit: numCandidates,
    },
  };

  const [vectorIds, totalResult] = await Promise.all([
    Product.aggregate([
      vectorStage,
      { $match: vectorFilter },
      { $project: { _id: 1 } },
      { $skip: (pageNum - 1) * limitNum },
      { $limit: limitNum },
    ]),
    Product.aggregate([vectorStage, { $match: vectorFilter }, { $count: "total" }]),
  ]);

  const ids = vectorIds.map((d) => d._id);
  const products = await fetchOrderedDocs(ids);
  const total = totalResult[0]?.total ?? products.length;

  return {
    products,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    searchMode: "vector",
  };
}

// ---------------------------------------------------------------------------
// Keyword fallback (the existing normal product search)
// ---------------------------------------------------------------------------
export async function keywordSearch({ query, filters = {}, page = 1, limit = 20 }) {
  const { page: pageNum, limit: limitNum } = normalizePagination(page, limit);
  const baseFilter = await buildProductFilters(filters);
  const filter = query ? { $and: [{ $text: { $search: query } }, baseFilter] } : baseFilter;

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort({ "stats.totalSold": -1, createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate(POPULATE)
      .lean(),
    Product.countDocuments(filter),
  ]);

  return {
    products,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    searchMode: "keyword",
  };
}

// ---------------------------------------------------------------------------
// Entry point: vector search first, graceful fallback to keyword search.
// AI/vector failures (no key, no index, timeout) must never break the API.
// ---------------------------------------------------------------------------
export async function searchProducts({ query, filters = {}, page = 1, limit = 20, mode = "auto", deps = {} }) {
  try {
    if (mode === "keyword") {
      return await keywordSearch({ query, filters, page, limit });
    }
    return await semanticSearch({ query, filters, page, limit, deps });
  } catch (err) {
    if (mode === "vector" && err instanceof AIError) {
      // Explicit vector mode: still degrade gracefully instead of 500ing.
      console.error(`[AI] Semantic search failed (${err.code}): ${err.message} — falling back to keyword`);
    }
    return keywordSearch({ query, filters, page, limit });
  }
}