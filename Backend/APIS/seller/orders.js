import { Router } from "express";
import Order from "../../models/Order.js";
import Variant from "../../models/Variant.js";
import Notification from "../../models/Notification.js";

const router = Router();

// List all orders for this seller
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, status, search } = req.query;
    const filter = { seller: req.seller._id };
    if (status) filter.status = status;
    if (search) filter.orderNumber = { $regex: search, $options: "i" };

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("customer", "name email phone").populate("store", "name slug").lean(),
      Order.countDocuments(filter),
    ]);

    res.json({ success: true, data: orders, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Cancel an order (only if placed or confirmed)
router.put("/:orderId/cancel", async (req, res) => {
    const { reason = "" } = req.body;
    const order = await Order.findOne({ _id: req.params.orderId, seller: req.seller._id });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (!["placed", "confirmed"].includes(order.status)) return res.status(400).json({ success: false, message: `Cannot cancel in "${order.status}" status` });

    order.status = "cancelled";
    order.cancellationReason = reason;
    order.cancelledBy = req.user._id;
    order.statusHistory.push({ status: "cancelled", note: reason, changedBy: req.user._id });
    await order.save();

    for (const item of order.items) {
      if (item.variant) await Variant.findByIdAndUpdate(item.variant, { $inc: { stock: item.quantity } });
    }

    await Notification.create({ recipient: order.customer, type: "order_cancelled", title: "Order Cancelled", message: `Order ${order.orderNumber} cancelled by seller. ${reason}`, data: { entityType: "order", entityId: order._id } });
    res.json({ success: true, message: "Order cancelled", data: order });
});

// Get single order detail with populated customer and items
router.get("/:orderId", async (req, res) => {
    const order = await Order.findOne({ _id: req.params.orderId, seller: req.seller._id })
      .populate("customer", "name email phone").populate("store", "name slug")
      .populate("items.product", "name slug images").populate("items.variant", "label sku")
      .populate("deliveryPartner", "name phone");
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    res.json({ success: true, data: order });
});

// Update order status following the state machine: placed→confirmed→packed→shipped→out_for_delivery→delivered
router.put("/:orderId/status", async (req, res) => {
    const { status, note = "", trackingNumber, estimatedDelivery } = req.body;

    const validTransitions = {
      placed: ["confirmed", "cancelled"], confirmed: ["packed", "cancelled"],
      packed: ["shipped"], shipped: ["out_for_delivery"], out_for_delivery: ["delivered"],
    };

    const order = await Order.findOne({ _id: req.params.orderId, seller: req.seller._id });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const allowed = validTransitions[order.status];
    if (!allowed || !allowed.includes(status)) return res.status(400).json({ success: false, message: `Cannot transition from "${order.status}" to "${status}"` });

    order.status = status;
    order.statusHistory.push({ status, note, changedBy: req.user._id });
    if (trackingNumber) order.trackingNumber = trackingNumber;
    if (estimatedDelivery) order.estimatedDelivery = new Date(estimatedDelivery);

    if (status === "delivered") { order.deliveredAt = new Date(); order.payment.status = "completed"; if (!order.payment.paidAt) order.payment.paidAt = new Date(); }
    if (status === "cancelled") { order.cancellationReason = note; order.cancelledBy = req.user._id; }

    await order.save();

    const notifMap = { confirmed: "order_confirmed", shipped: "order_shipped", delivered: "order_delivered", cancelled: "order_cancelled" };
    if (notifMap[status]) {
      await Notification.create({ recipient: order.customer, type: notifMap[status], title: `Order ${status.replace(/_/g, " ")}`, message: `Your order ${order.orderNumber} has been ${status.replace(/_/g, " ")}`, data: { entityType: "order", entityId: order._id } });
    }

    res.json({ success: true, message: `Order status updated to "${status}"`, data: order });
});

export default router;
