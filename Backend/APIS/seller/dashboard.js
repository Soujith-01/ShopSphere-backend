import { Router } from "express";
import Product from "../../models/Product.js";
import Order from "../../models/Order.js";
import Review from "../../models/Review.js";
import Variant from "../../models/Variant.js";

const router = Router();

// Get seller dashboard stats (products, orders, revenue, reviews)
router.get("/", async (req, res) => {
    const sellerId = req.seller._id;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalProducts, activeProducts, draftProducts, pendingProducts, lowStockProducts, totalOrders, ordersToday, revenueThisMonth, totalRevenue, pendingOrders, deliveredOrders, cancelledOrders, avgRating, totalReviews] = await Promise.all([
      Product.countDocuments({ seller: sellerId }),
      Product.countDocuments({ seller: sellerId, status: "active" }),
      Product.countDocuments({ seller: sellerId, status: "draft" }),
      Product.countDocuments({ seller: sellerId, status: "pending" }),
      Variant.aggregate([{ $lookup: { from: "products", localField: "product", foreignField: "_id", as: "prod" } }, { $unwind: "$prod" }, { $match: { "prod.seller": sellerId, $expr: { $lte: ["$stock", "$lowStockThreshold"] }, isActive: true } }, { $count: "count" }]),
      Order.countDocuments({ seller: sellerId }),
      Order.countDocuments({ seller: sellerId, createdAt: { $gte: startOfDay } }),
      Order.aggregate([{ $match: { seller: sellerId, createdAt: { $gte: startOfMonth }, status: { $ne: "cancelled" } } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
      Order.aggregate([{ $match: { seller: sellerId, status: { $ne: "cancelled" } } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
      Order.countDocuments({ seller: sellerId, status: { $in: ["placed", "confirmed"] } }),
      Order.countDocuments({ seller: sellerId, status: "delivered" }),
      Order.countDocuments({ seller: sellerId, status: "cancelled" }),
      Review.aggregate([{ $match: { seller: sellerId } }, { $group: { _id: null, avg: { $avg: "$rating" } } }]),
      Review.countDocuments({ seller: sellerId }),
    ]);

    res.json({
      success: true, data: {
        products: { total: totalProducts, active: activeProducts, draft: draftProducts, pending: pendingProducts, lowStock: lowStockProducts[0]?.count || 0 },
        orders: { total: totalOrders, today: ordersToday, pending: pendingOrders, delivered: deliveredOrders, cancelled: cancelledOrders },
        revenue: { thisMonth: revenueThisMonth[0]?.total || 0, allTime: totalRevenue[0]?.total || 0 },
        reviews: { avgRating: avgRating[0]?.avg ? +avgRating[0].avg.toFixed(1) : 0, total: totalReviews },
      },
    });
});

// Get recent orders for dashboard widget
router.get("/recent-orders", async (req, res) => {
    const limit = Math.min(20, Number(req.query.limit) || 10);
    const orders = await Order.find({ seller: req.seller._id }).sort({ createdAt: -1 }).limit(limit)
      .populate("customer", "name").select("orderNumber status total createdAt customer").lean();
    res.json({ success: true, data: orders });
});

// Get revenue chart data (daily aggregation for last 7–90 days)
router.get("/revenue-chart", async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const data = await Order.aggregate([
      { $match: { seller: req.seller._id, createdAt: { $gte: startDate }, status: { $ne: "cancelled" } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json({ success: true, data });
});

export default router;
