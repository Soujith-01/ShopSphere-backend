import Product from "../../models/Product.js";
import User from "../../models/User.js";
import Cart from "../../models/Cart.js";
import UserEvent from "../../models/UserEvent.js";
import { AIError } from "../../config/gemini.js";

const VECTOR_INDEX_NAME = process.env.ATLAS_VECTOR_INDEX_NAME || "product_embedding_index";
const POPULATE = [
  { path: "category", select: "name slug" },
  { path: "store", select: "name slug logo" },
];

// Configurable event weights — stronger actions mean stronger interest
export const EVENT_WEIGHTS = {
  VIEW: 1,
  CLICK: 2,
  WISHLIST: 4,
  ADD_TO_CART: 5,
  PURCHASE: 6,
};

const MAX_INTEREST_PRODUCTS = 25;
const EVENTS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const numCandidatesFor = (limit, page) =>
  Math.min(10000, Math.max(limit * (page + 1) * 20, 200));

// Pure helper — testable without DB/Gemini
export function computeInterestScores(events, { weights = EVENT_WEIGHTS } = {}) {
  const scores = new Map();
  for (const ev of events || []) {
    if (!ev.productId) continue;
    const pid = String(ev.productId);
    const w = weights[ev.eventType] ?? 1;
    scores.set(pid, (scores.get(pid) || 0) + w);
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

// Weighted average of interacted products' embeddings → user interest vector
function buildInterestVector(productsWithEmbedding, weightMap, dimension) {
  const vector = new Array(dimension).fill(0);
  let totalWeight = 0;
  for (const p of productsWithEmbedding) {
    const w = weightMap.get(String(p._id)) || 1;
    for (let i = 0; i < dimension; i++) {
      vector[i] += (p.aiEmbedding[i] || 0) * w;
    }
    totalWeight += w;
  }
  if (totalWeight === 0) return null;
  for (let i = 0; i < dimension; i++) vector[i] /= totalWeight;
  return vector;
}

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

// Fallback for new users (or when behavior data is insufficient):
// real popular / trending / high-rated products.
export async function popularProducts({ page = 1, limit = 20, excludeIds = [] } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = { status: "active" };
  if (excludeIds.length) filter._id = { $nin: excludeIds };

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort({ "stats.totalSold": -1, "stats.avgRating": -1, createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate(POPULATE)
      .lean(),
    Product.countDocuments(filter),
  ]);

  return {
    products,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    source: "popular",
  };
}

// Behavior-based recommendations:
//   user events (+ wishlist + cart) → weighted product interests → interest vector
//   → Atlas vector search → filtering → ranking → recommendations
export async function getRecommendations(userId, { page = 1, limit = 20, filters = {}, deps = {} } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(50, Math.max(1, Number(limit) || 20));

  const [events, user, cart] = await Promise.all([
    UserEvent.find({
      userId,
      createdAt: { $gte: new Date(Date.now() - EVENTS_WINDOW_MS) },
    })
      .select("productId eventType")
      .lean(),
    User.findById(userId).select("wishlist").lean(),
    Cart.findOne({ user: userId }).select("items").lean(),
  ]);

  // Weighted interest per product (events + wishlist + cart as extra signals)
  const scores = computeInterestScores(events);
  const scoreMap = new Map(scores);
  for (const wishId of user?.wishlist || []) {
    const k = String(wishId);
    scoreMap.set(k, (scoreMap.get(k) || 0) + EVENT_WEIGHTS.WISHLIST);
  }
  for (const item of cart?.items || []) {
    const k = String(item.product);
    scoreMap.set(k, (scoreMap.get(k) || 0) + EVENT_WEIGHTS.ADD_TO_CART);
  }
  const ranked = [...scoreMap.entries()].sort((a, b) => b[1] - a[1]);

  // Never recommend products the user already bought
  const purchasedIds = new Set(
    (events || [])
      .filter((e) => e.eventType === "PURCHASE")
      .map((e) => String(e.productId))
  );

  // New user / insufficient history → popular fallback
  if (ranked.length === 0) {
    return popularProducts({ page: pageNum, limit: limitNum, excludeIds: [...purchasedIds] });
  }

  const top = ranked.slice(0, MAX_INTEREST_PRODUCTS);
  const weightMap = new Map(top);
  const interactedProducts = await Product.find({
    _id: { $in: top.map(([id]) => id) },
    status: "active",
    aiEmbedding: { $exists: true, $ne: [] },
  })
    .select("aiEmbedding")
    .lean();

  const withEmbedding = interactedProducts.filter(
    (p) => Array.isArray(p.aiEmbedding) && p.aiEmbedding.length
  );

  if (withEmbedding.length === 0) {
    return popularProducts({ page: pageNum, limit: limitNum, excludeIds: [...purchasedIds] });
  }

  const interestVector = buildInterestVector(withEmbedding, weightMap, withEmbedding[0].aiEmbedding.length);
  if (!interestVector) {
    return popularProducts({ page: pageNum, limit: limitNum, excludeIds: [...purchasedIds] });
  }

  const vectorFilter = { status: "active", aiEmbedding: { $exists: true, $ne: [] } };
  if (purchasedIds.size) vectorFilter._id = { $nin: [...purchasedIds] };
  if (filters.category) vectorFilter.category = filters.category;
  if (filters.subCategory) vectorFilter.subCategory = filters.subCategory;
  if (filters.seller) vectorFilter.seller = filters.seller;
  if (filters.minPrice) vectorFilter.price = { ...(vectorFilter.price || {}), $gte: Number(filters.minPrice) };
  if (filters.maxPrice) vectorFilter.price = { ...(vectorFilter.price || {}), $lte: Number(filters.maxPrice) };

  const numCandidates = numCandidatesFor(limitNum, pageNum);
  const vectorStage = {
    $vectorSearch: {
      index: VECTOR_INDEX_NAME,
      path: "aiEmbedding",
      queryVector: interestVector,
      numCandidates,
      limit: numCandidates,
    },
  };

  let ids = [];
  let total = 0;
  try {
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
    ids = vectorIds.map((d) => d._id);
    total = totalResult[0]?.total ?? ids.length;
  } catch (err) {
    // No vector index / non-Atlas deployment → fall back to popular, never crash.
    console.error(`[AI] Vector search failed for recommendations: ${err.message}`);
    return popularProducts({ page: pageNum, limit: limitNum, excludeIds: [...purchasedIds] });
  }

  if (ids.length === 0) {
    return popularProducts({ page: pageNum, limit: limitNum, excludeIds: [...purchasedIds] });
  }

  const products = await fetchOrderedDocs(ids);
  return {
    products,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    source: "behavior",
  };
}