import { Router } from "express";
import Review from "../../models/Review.js";
import Order from "../../models/Order.js";
import Product from "../../models/Product.js";
import Notification from "../../models/Notification.js";
import { protect } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect);

// Get all my reviews across all products
router.get("/my", async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [reviews, total] = await Promise.all([
        Review.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .populate("product", "name slug images")
            .populate("order", "orderNumber")
            .lean(),
        Review.countDocuments({ user: req.user._id }),
    ]);

    res.json({
        success: true,
        data: reviews,
        pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
});

// Get the current user's review for a product (null if they haven't reviewed it)
router.get("/my/:productId", async (req, res) => {
    const review = await Review.findOne({ product: req.params.productId, user: req.user._id }).lean();
    res.json({ success: true, data: review || null });
});

// Get reviews for a product with pagination and sort
router.get("/product/:productId", async (req, res) => {
    const { page = 1, limit = 10, rating, sort = "newest" } = req.query;
    const filter = { product: req.params.productId, isApproved: true };
    if (rating) filter.rating = Number(rating);

    let sortOption = { createdAt: -1 };
    if (sort === "highest") sortOption = { rating: -1, createdAt: -1 };
    if (sort === "lowest") sortOption = { rating: 1, createdAt: -1 };
    if (sort === "helpful") sortOption = { helpfulCount: -1, createdAt: -1 };

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [reviews, total] = await Promise.all([
      Review.find(filter).sort(sortOption).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("user", "name avatar").lean(),
      Review.countDocuments(filter),
    ]);

    res.json({ success: true, data: reviews, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Create a review (verified purchase only, one per product per user)
router.post("/", async (req, res) => {
    const { productId, orderId, rating, title, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: "Rating must be between 1 and 5" });
    }

    const order = await Order.findOne({ _id: orderId, customer: req.user._id, status: "delivered", "items.product": productId });
    if (!order) return res.status(400).json({ success: false, message: "You can only review products from delivered orders" });

    const existing = await Review.findOne({ product: productId, user: req.user._id });
    if (existing) return res.status(400).json({ success: false, message: "You have already reviewed this product" });

    const product = await Product.findById(productId);

    const review = await Review.create({
      product: productId, user: req.user._id, order: orderId, seller: product.seller,
      rating, title: title || "", comment: comment || "",
      images: (req.body.images || []).map((img) => ({ url: img.url, publicId: img.publicId })),
    });

    // Recalculate product rating stats
    const stats = await Review.aggregate([
      { $match: { product: product._id, isApproved: true } },
      { $group: { _id: null, avgRating: { $avg: "$rating" }, totalReviews: { $sum: 1 } } },
    ]);
    if (stats.length) {
      await Product.findByIdAndUpdate(productId, { "stats.avgRating": +stats[0].avgRating.toFixed(1), "stats.totalReviews": stats[0].totalReviews });
    }

    await Notification.create({ recipient: product.seller, type: "new_review", title: "New Product Review", message: `A customer left a ${rating}-star review on "${product.name}"`, data: { entityType: "review", entityId: review._id } });

    res.status(201).json({ success: true, message: "Review submitted", data: review });
});

// Update own review
router.put("/:reviewId", async (req, res) => {
    const review = await Review.findOne({ _id: req.params.reviewId, user: req.user._id });
    if (!review) return res.status(404).json({ success: false, message: "Review not found" });

    const { rating, title, comment } = req.body;
    if (rating) review.rating = rating;
    if (title !== undefined) review.title = title;
    if (comment !== undefined) review.comment = comment;
    await review.save();

    const stats = await Review.aggregate([
      { $match: { product: review.product, isApproved: true } },
      { $group: { _id: null, avgRating: { $avg: "$rating" }, totalReviews: { $sum: 1 } } },
    ]);
    if (stats.length) {
      await Product.findByIdAndUpdate(review.product, { "stats.avgRating": +stats[0].avgRating.toFixed(1), "stats.totalReviews": stats[0].totalReviews });
    }

    res.json({ success: true, data: review });
});

// Delete own review
router.delete("/:reviewId", async (req, res) => {
    const review = await Review.findOne({ _id: req.params.reviewId, user: req.user._id });
    if (!review) return res.status(404).json({ success: false, message: "Review not found" });

    const productId = review.product;
    await review.deleteOne();

    const stats = await Review.aggregate([
      { $match: { product: productId, isApproved: true } },
      { $group: { _id: null, avgRating: { $avg: "$rating" }, totalReviews: { $sum: 1 } } },
    ]);
    await Product.findByIdAndUpdate(productId, {
      "stats.avgRating": stats.length ? +stats[0].avgRating.toFixed(1) : 0,
      "stats.totalReviews": stats.length ? stats[0].totalReviews : 0,
    });

    res.json({ success: true, message: "Review deleted" });
});

export default router;
