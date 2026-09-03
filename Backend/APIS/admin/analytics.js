import { Router } from "express";
import Order from "../../models/Order.js";
import User from "../../models/User.js";
import Product from "../../models/Product.js";
import Seller from "../../models/Seller.js";

const router = Router();

// Get daily revenue data for charts (7–365 days)
router.get("/revenue", async (req, res) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const data = await Order.aggregate([
      { $match: { createdAt: { $gte: startDate }, status: { $ne: "cancelled" } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json({ success: true, data });
});

// Get top sellers ranked by revenue
router.get("/top-sellers", async (req, res) => {
    const limit = Math.min(50, Number(req.query.limit) || 10);
    const sellers = await Seller.find({ isActive: true }).sort({ "stats.totalRevenue": -1 }).limit(limit)
      .populate("user", "name email").select("businessName stats commissionRate").lean();
    res.json({ success: true, data: sellers });
});

// Get top products ranked by units sold
router.get("/top-products", async (req, res) => {
    const limit = Math.min(50, Number(req.query.limit) || 10);
    const products = await Product.find({ status: "active" }).sort({ "stats.totalSold": -1 }).limit(limit)
      .populate("seller", "businessName").select("name slug price stats images").lean();
    res.json({ success: true, data: products });
});

// Get platform-wide overview (users, sellers, products, revenue)
router.get("/", async (req, res) => {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [totalUsers, newUsersThisMonth, totalSellers, verifiedSellers, totalProducts, activeProducts, pendingProducts, totalOrders, revenueThisMonth, totalRevenue] = await Promise.all([
      User.countDocuments(), User.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Seller.countDocuments(), Seller.countDocuments({ isVerified: true }),
      Product.countDocuments(), Product.countDocuments({ status: "active" }), Product.countDocuments({ status: "pending" }),
      Order.countDocuments(),
      Order.aggregate([{ $match: { createdAt: { $gte: startOfMonth }, status: { $ne: "cancelled" } } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
      Order.aggregate([{ $match: { status: { $ne: "cancelled" } } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
    ]);

    res.json({ success: true, data: {
      users: { total: totalUsers, newThisMonth: newUsersThisMonth },
      sellers: { total: totalSellers, verified: verifiedSellers },
      products: { total: totalProducts, active: activeProducts, pending: pendingProducts },
      orders: { total: totalOrders },
      revenue: { thisMonth: revenueThisMonth[0]?.total || 0, allTime: totalRevenue[0]?.total || 0 },
    }});
});

export default router;
