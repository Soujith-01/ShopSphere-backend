import { Router } from "express";
import Order from "../../models/Order.js";

const router = Router();

// Get order analytics (today, this month, total, status breakdown)
router.get("/stats", async (req, res) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalOrders, ordersToday, ordersThisMonth, totalRevenue, revenueThisMonth, statusBreakdown] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ createdAt: { $gte: startOfDay } }),
      Order.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Order.aggregate([{ $match: { status: { $ne: "cancelled" } } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
      Order.aggregate([{ $match: { createdAt: { $gte: startOfMonth }, status: { $ne: "cancelled" } } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    ]);

    res.json({ success: true, data: { totalOrders, ordersToday, ordersThisMonth, totalRevenue: totalRevenue[0]?.total || 0, revenueThisMonth: revenueThisMonth[0]?.total || 0, statusBreakdown } });
});

// List all orders (filter by status, seller, search by order number)
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, status, search, sellerId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (sellerId) filter.seller = sellerId;
    if (search) filter.orderNumber = { $regex: search, $options: "i" };

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("customer", "name email").populate("seller", "businessName").populate("store", "name").lean(),
      Order.countDocuments(filter),
    ]);
    res.json({ success: true, data: orders, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get single order detail with all populated fields
router.get("/:orderId", async (req, res) => {
    const order = await Order.findById(req.params.orderId)
      .populate("customer", "name email phone").populate("seller", "businessName").populate("store", "name")
      .populate("items.product", "name slug").populate("deliveryPartner", "name phone");
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    res.json({ success: true, data: order });
});

export default router;
