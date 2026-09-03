import { Router } from "express";
import Product from "../../models/Product.js";
import Variant from "../../models/Variant.js";
import Review from "../../models/Review.js";
import Category from "../../models/Category.js";

const router = Router();

// Get featured products for homepage
router.get("/featured", async (req, res) => {
    const limit = Math.min(50, Number(req.query.limit) || 12);
    const products = await Product.find({ status: "active", isFeatured: true })
      .sort({ "stats.totalSold": -1 })
      .limit(limit)
      .populate("category", "name slug")
      .populate("store", "name slug logo")
      .lean();

    res.json({ success: true, data: products });
});

// Get all active products with filters, search, and pagination
router.get("/", async (req, res) => {
    const {
      page = 1, limit = 20, search, category, subCategory,
      minPrice, maxPrice, sort, rating, freeShipping, seller, store,
    } = req.query;

    const filter = { status: "active" };

    if (search) filter.$text = { $search: search };
    if (category) filter.category = category;
    if (subCategory) filter.subCategory = subCategory;
    if (seller) filter.seller = seller;
    if (store) filter.store = store;

    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    if (rating) filter["stats.avgRating"] = { $gte: Number(rating) };
    if (freeShipping === "true") filter["shipping.freeShipping"] = true;

    let sortOption = { createdAt: -1 };
    switch (sort) {
      case "price_asc": sortOption = { price: 1 }; break;
      case "price_desc": sortOption = { price: -1 }; break;
      case "rating": sortOption = { "stats.avgRating": -1 }; break;
      case "popular": sortOption = { "stats.totalSold": -1 }; break;
      case "newest": sortOption = { createdAt: -1 }; break;
    }

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [products, total] = await Promise.all([
      Product.find(filter).sort(sortOption).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("category", "name slug").populate("store", "name slug logo").lean(),
      Product.countDocuments(filter),
    ]);

    res.json({ success: true, data: products, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get products by category slug with pagination and sort
router.get("/category/:categorySlug", async (req, res) => {
    const category = await Category.findOne({ slug: req.params.categorySlug });
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });

    const { page = 1, limit = 20, sort } = req.query;
    const filter = { status: "active", category: category._id };

    let sortOption = { createdAt: -1 };
    if (sort === "price_asc") sortOption = { price: 1 };
    if (sort === "price_desc") sortOption = { price: -1 };
    if (sort === "popular") sortOption = { "stats.totalSold": -1 };

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [products, total] = await Promise.all([
      Product.find(filter).sort(sortOption).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("category", "name slug").populate("store", "name slug logo").lean(),
      Product.countDocuments(filter),
    ]);

    res.json({ success: true, data: { category, products }, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get single product detail by slug with variants and review summary
router.get("/:slug", async (req, res) => {
    const product = await Product.findOne({ slug: req.params.slug, status: "active" })
      .populate("category", "name slug")
      .populate("subCategory", "name slug")
      .populate("seller", "businessName")
      .populate("store", "name slug logo banner address");

    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    // Increment views (fire and forget)
    Product.updateOne({ _id: product._id }, { $inc: { "stats.totalViews": 1 } }).exec();

    // Get variants if product has them
    let variants = [];
    if (product.hasVariants) {
      variants = await Variant.find({ product: product._id, isActive: true }).sort({ label: 1 }).lean();
    }

    // Get review summary with rating breakdown
    const reviewStats = await Review.aggregate([
      { $match: { product: product._id, isApproved: true } },
      { $group: { _id: "$rating", count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
    ]);

    const ratingBreakdown = {};
    let totalReviews = 0;
    let weightedSum = 0;
    for (const r of reviewStats) {
      ratingBreakdown[r._id] = r.count;
      totalReviews += r.count;
      weightedSum += r._id * r.count;
    }

    res.json({
      success: true,
      data: {
        ...product.toObject(),
        variants,
        reviewSummary: {
          avgRating: totalReviews > 0 ? +(weightedSum / totalReviews).toFixed(1) : 0,
          totalReviews,
          breakdown: ratingBreakdown,
        },
      },
    });
});

export default router;
