import { Router } from "express";
import Order from "../../models/Order.js";
import User from "../../models/User.js";
import Notification from "../../models/Notification.js";
import { protect, authorize } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect, authorize("delivery"));

// Update delivery partner profile (availability, vehicle type)
router.put("/profile", async (req, res) => {
    const { isAvailable, vehicleType, coordinates } = req.body;
    const updates = {};
    if (isAvailable !== undefined) updates["deliveryPartner.isAvailable"] = isAvailable;
    if (vehicleType !== undefined) updates["deliveryPartner.vehicleType"] = vehicleType;
    if (coordinates) updates["deliveryPartner.currentLocation.coordinates"] = coordinates;

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select("-password -refreshToken");
    res.json({ success: true, data: user });
});

// Update current GPS location
router.put("/location", async (req, res) => {
    const { coordinates } = req.body;
    if (!coordinates || !Array.isArray(coordinates) || coordinates.length !== 2) {
      return res.status(400).json({ success: false, message: "coordinates must be [longitude, latitude]" });
    }
    await User.findByIdAndUpdate(req.user._id, { "deliveryPartner.currentLocation.coordinates": coordinates });
    res.json({ success: true, message: "Location updated" });
});

// Get delivery stats (total, active, today, monthly)
router.get("/stats", async (req, res) => {
    const partnerId = req.user._id;
    const [totalDeliveries, activeDeliveries, todayDeliveries, completedThisMonth] = await Promise.all([
      Order.countDocuments({ deliveryPartner: partnerId, status: "delivered" }),
      Order.countDocuments({ deliveryPartner: partnerId, status: "out_for_delivery" }),
      Order.countDocuments({ deliveryPartner: partnerId, deliveredAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
      Order.countDocuments({ deliveryPartner: partnerId, status: "delivered", deliveredAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } }),
    ]);
    res.json({ success: true, data: { totalDeliveries, activeDeliveries, todayDeliveries, completedThisMonth } });
});

// Browse available orders (shipped, no delivery partner assigned yet)
router.get("/orders/available", async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const filter = { status: "shipped", deliveryPartner: null };
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("customer", "name phone").populate("seller", "businessName").populate("store", "name address").lean(),
      Order.countDocuments(filter),
    ]);
    res.json({ success: true, data: orders, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get my active deliveries
router.get("/orders/active", async (req, res) => {
    const orders = await Order.find({ deliveryPartner: req.user._id, status: "out_for_delivery" })
      .sort({ createdAt: -1 }).populate("customer", "name phone").populate("seller", "businessName").populate("store", "name address").lean();
    res.json({ success: true, data: orders });
});

// Get delivery history (delivered + cancelled)
router.get("/orders/history", async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const filter = { deliveryPartner: req.user._id, status: { $in: ["delivered", "cancelled"] } };
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("customer", "name").populate("store", "name").lean(),
      Order.countDocuments(filter),
    ]);
    res.json({ success: true, data: orders, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Accept an order (assign yourself as delivery partner)
router.put("/orders/:orderId/accept", async (req, res) => {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (order.status !== "shipped") return res.status(400).json({ success: false, message: "Order is not available for delivery" });
    if (order.deliveryPartner && order.deliveryPartner.toString() !== req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "Order already assigned to another partner" });
    }

    order.deliveryPartner = req.user._id;
    order.status = "out_for_delivery";
    order.statusHistory.push({ status: "out_for_delivery", note: "Assigned to delivery partner", changedBy: req.user._id });
    await order.save();

    await Notification.create({ recipient: order.customer, type: "order_shipped", title: "Out for Delivery", message: `Order ${order.orderNumber} is out for delivery`, data: { entityType: "order", entityId: order._id } });
    res.json({ success: true, message: "Order accepted", data: order });
});

// Mark order as delivered
router.put("/orders/:orderId/deliver", async (req, res) => {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (order.deliveryPartner?.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: "Not assigned to this order" });
    if (order.status !== "out_for_delivery") return res.status(400).json({ success: false, message: `Cannot deliver in "${order.status}" status` });

    order.status = "delivered";
    order.deliveredAt = new Date();
    order.payment.status = "completed";
    if (!order.payment.paidAt) order.payment.paidAt = new Date();
    order.statusHistory.push({ status: "delivered", note: req.body.note || "Delivered successfully", changedBy: req.user._id });
    await order.save();

    await Notification.create({ recipient: order.customer, type: "order_delivered", title: "Order Delivered", message: `Order ${order.orderNumber} has been delivered`, data: { entityType: "order", entityId: order._id } });
    await Notification.create({ recipient: order.seller, type: "order_delivered", title: "Order Delivered", message: `Order ${order.orderNumber} has been delivered`, data: { entityType: "order", entityId: order._id } });
    res.json({ success: true, message: "Order delivered", data: order });
});

export default router;
