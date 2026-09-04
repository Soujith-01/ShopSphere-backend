import { Router } from "express";
import { body, query } from "express-validator";
import { rateLimit } from "express-rate-limit";
import { protect } from "../../middlewares/authMiddleware.js";
import { requireSeller } from "../../middlewares/sellerMiddleware.js";
import { validate } from "../../middlewares/validateMiddleware.js";
import { isGeminiConfigured } from "../../config/gemini.js";
import { generateProductDescription } from "../../services/ai/description.js";
import { searchProducts } from "../../services/ai/search.js";
import { getRecommendations } from "../../services/ai/recommendations.js";
import UserEvent from "../../models/UserEvent.js";
import Product from "../../models/Product.js";

const router = Router();

// Per-endpoint rate limits (IP-based). AI calls are expensive — keep them tight.
const aiLimiter = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, message },
  });

// 503 when GEMINI_API_KEY is missing (only for endpoints that strictly need AI)
const requireAI = (req, res, next) => {
  if (!isGeminiConfigured()) {
    return res.status(503).json({
      success: false,
      message: "AI service is not configured (GEMINI_API_KEY missing)",
    });
  }
  next();
};

// ---------------------------------------------------------------------------
// POST /api/ai/product-description
// Generate a professional product description + 4-6 selling points with Gemini.
// Only authenticated SELLERS. Uses ONLY the supplied product data — no invented facts.
// ---------------------------------------------------------------------------
router.post(
  "/product-description",
  aiLimiter(15 * 60 * 1000, 10, "Too many AI description requests. Try again later."),
  protect,
  requireSeller,
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Product name is required")
      .isLength({ max: 200 })
      .withMessage("Name must be at most 200 characters"),
    body("brand").optional().trim().isLength({ max: 100 }).withMessage("Brand must be at most 100 characters"),
    body("category").optional().trim().isLength({ max: 100 }).withMessage("Category must be at most 100 characters"),
    body("attributes")
      .optional()
      .custom((v) => {
        if (v === null || typeof v !== "object") return false;
        if (Array.isArray(v)) {
          return v.every(
            (a) =>
              a &&
              typeof a === "object" &&
              typeof a.name === "string" &&
              a.name.length <= 100 &&
              typeof a.value === "string" &&
              a.value.length <= 200
          );
        }
        return Object.values(v).every((val) => typeof val === "string" && val.length <= 200);
      })
      .withMessage("attributes must be an object or an array of { name, value } (max 200 chars per value)"),
    body("features").optional().isArray({ max: 20 }).withMessage("features must be an array of max 20 items"),
    body("features.*").isString().isLength({ max: 200 }).withMessage("Each feature must be a string (max 200 chars)"),
  ],
  validate,
  requireAI,
  async (req, res) => {
    const { name, brand = "", category = "", attributes = {}, features = [] } = req.body;

    const result = await generateProductDescription({ name, brand, category, attributes, features });

    res.json({
      success: true,
      data: {
        description: result.description,
        sellingPoints: result.sellingPoints,
      },
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/ai/search?q=<query>
// Semantic search: query → Gemini embedding → Atlas Vector Search → filters → pagination.
// Gracefully falls back to the normal keyword search if AI/vector search is unavailable.
// ---------------------------------------------------------------------------
router.get(
  "/search",
  aiLimiter(60 * 1000, 60, "Too many search requests. Try again later."),
  [
    query("q").trim().notEmpty().withMessage("q (search query) is required").isLength({ max: 200 }).withMessage("Query must be at most 200 characters"),
    query("category").optional().isMongoId().withMessage("category must be a valid ObjectId"),
    query("subCategory").optional().isMongoId().withMessage("subCategory must be a valid ObjectId"),
    query("seller").optional().isMongoId().withMessage("seller must be a valid ObjectId"),
    query("store").optional().isMongoId().withMessage("store must be a valid ObjectId"),
    query("brand").optional().trim().isLength({ max: 100 }).withMessage("brand must be at most 100 characters"),
    query("minPrice").optional().isFloat({ min: 0 }).withMessage("minPrice must be a number >= 0"),
    query("maxPrice").optional().isFloat({ min: 0 }).withMessage("maxPrice must be a number >= 0"),
    query("rating").optional().isFloat({ min: 0, max: 5 }).withMessage("rating must be between 0 and 5"),
    query("availability").optional().isIn(["in_stock", "any"]).withMessage("availability must be 'in_stock' or 'any'"),
    query("mode").optional().isIn(["auto", "vector", "keyword"]).withMessage("mode must be 'auto', 'vector' or 'keyword'"),
    query("page").optional().isInt({ min: 1 }).withMessage("page must be an integer >= 1"),
    query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be an integer 1-100"),
  ],
  validate,
  async (req, res) => {
    const {
      q,
      category,
      subCategory,
      seller,
      store,
      brand,
      minPrice,
      maxPrice,
      rating,
      availability,
      mode = "auto",
      page = 1,
      limit = 20,
    } = req.query;

    const result = await searchProducts({
      query: q,
      filters: { category, subCategory, seller, store, brand, minPrice, maxPrice, rating, availability },
      page,
      limit,
      mode,
    });

    res.json({
      success: true,
      data: result.products,
      pagination: result.pagination,
      searchMode: result.searchMode,
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/ai/events
// Record a user behavior event (VIEW, CLICK, SEARCH, WISHLIST, ADD_TO_CART, PURCHASE).
// userId always comes from the JWT — client-supplied userId is never trusted.
// ---------------------------------------------------------------------------
router.post(
  "/events",
  aiLimiter(60 * 1000, 120, "Too many event requests. Try again later."),
  protect,
  [
    body("productId").isMongoId().withMessage("productId must be a valid ObjectId"),
    body("eventType")
      .isIn(["VIEW", "CLICK", "SEARCH", "WISHLIST", "ADD_TO_CART", "PURCHASE"])
      .withMessage("eventType must be VIEW, CLICK, SEARCH, WISHLIST, ADD_TO_CART or PURCHASE"),
    body("metadata").optional().isObject().withMessage("metadata must be an object"),
  ],
  validate,
  async (req, res) => {
    const { productId, eventType, metadata = {} } = req.body;

    // Verify the product exists (reject garbage events early)
    const product = await Product.exists({ _id: productId });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const event = await UserEvent.create({
      userId: req.user._id, // from JWT — never from the client
      productId,
      eventType: eventType.toUpperCase(),
      metadata,
    });

    res.status(201).json({ success: true, data: event });
  }
);

// ---------------------------------------------------------------------------
// GET /api/ai/recommendations
// Behavior-based recommendations (weighted events + wishlist + cart + purchase history
// → interest vector → Atlas vector search). New users get popular/high-rated fallback.
// ---------------------------------------------------------------------------
router.get(
  "/recommendations",
  aiLimiter(60 * 1000, 30, "Too many recommendation requests. Try again later."),
  protect,
  [
    query("page").optional().isInt({ min: 1 }).withMessage("page must be an integer >= 1"),
    query("limit").optional().isInt({ min: 1, max: 50 }).withMessage("limit must be an integer 1-50"),
    query("category").optional().isMongoId().withMessage("category must be a valid ObjectId"),
    query("subCategory").optional().isMongoId().withMessage("subCategory must be a valid ObjectId"),
    query("seller").optional().isMongoId().withMessage("seller must be a valid ObjectId"),
    query("minPrice").optional().isFloat({ min: 0 }).withMessage("minPrice must be a number >= 0"),
    query("maxPrice").optional().isFloat({ min: 0 }).withMessage("maxPrice must be a number >= 0"),
  ],
  validate,
  async (req, res) => {
    const { page = 1, limit = 20, category, subCategory, seller, minPrice, maxPrice } = req.query;

    const result = await getRecommendations(req.user._id, {
      page,
      limit,
      filters: { category, subCategory, seller, minPrice, maxPrice },
    });

    res.json({
      success: true,
      data: result.products,
      pagination: result.pagination,
      source: result.source, // "behavior" | "popular"
    });
  }
);

export default router;