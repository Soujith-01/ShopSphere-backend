import { Router } from "express";
import Order from "../../models/Order.js";
import User from "../../models/User.js";
import Product from "../../models/Product.js";
import Seller from "../../models/Seller.js";
import Wallet from "../../models/Wallet.js";
import WalletTransaction from "../../models/WalletTransaction.js";
import Notification from "../../models/Notification.js";
import ReturnRequest from "../../models/ReturnRequest.js";
import { protect, authorize } from "../../middlewares/authMiddleware.js";
import { syncOrderToSheet } from "../../services/sheetOrders.js";

const PLATFORM_COMMISSION_PERCENT = 10;

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

// Get delivery stats (total, active, today, monthly, active returns)
router.get("/stats", async (req, res) => {
    const partnerId = req.user._id;
    const [totalDeliveries, activeDeliveries, todayDeliveries, completedThisMonth, activeReturns] = await Promise.all([
      Order.countDocuments({ deliveryPartner: partnerId, status: "delivered" }),
      Order.countDocuments({ deliveryPartner: partnerId, status: "out_for_delivery" }),
      Order.countDocuments({ deliveryPartner: partnerId, deliveredAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
      Order.countDocuments({ deliveryPartner: partnerId, status: "delivered", deliveredAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } }),
      ReturnRequest.countDocuments({ deliveryPartner: partnerId, status: { $in: ["approved", "picked_up"] } }),
    ]);
    res.json({ success: true, data: { totalDeliveries, activeDeliveries, todayDeliveries, completedThisMonth, activeReturns } });
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

// Orders randomly auto-assigned to me at ship time, waiting for me to start
// the run (status still "shipped").
router.get("/orders/assigned", async (req, res) => {
    const orders = await Order.find({ deliveryPartner: req.user._id, status: "shipped" })
      .sort({ createdAt: -1 }).populate("customer", "name phone").populate("seller", "businessName").populate("store", "name address").lean();
    res.json({ success: true, data: orders });
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

// Start a delivery that was randomly auto-assigned to this partner when the
// seller shipped it. Moves shipped → out_for_delivery.
router.put("/orders/:orderId/start", async (req, res) => {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (order.deliveryPartner?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "This order is not assigned to you" });
    }
    if (order.status !== "shipped") {
      return res.status(400).json({ success: false, message: `Cannot start a "${order.status}" order` });
    }

    order.status = "out_for_delivery";
    order.statusHistory.push({ status: "out_for_delivery", note: "Delivery started by assigned partner", changedBy: req.user._id });
    await order.save();

    // Keep the seller's Orders tab (orderStatus column) in step
    await syncOrderToSheet(order);

    await Notification.create({ recipient: order.customer, type: "order_shipped", title: "Out for Delivery", message: `Order ${order.orderNumber} is out for delivery`, data: { entityType: "order", entityId: order._id } });
    await Notification.create({ recipient: order.seller, type: "order_shipped", title: "Order Out for Delivery", message: `Order ${order.orderNumber} has been picked up by the delivery partner and is on its way to the customer.`, data: { entityType: "order", entityId: order._id } });
    res.json({ success: true, message: "Delivery started", data: order });
});

// Accept an unassigned shipped order (manual fallback when no agent was on
// duty at ship time — or a partner prefers a specific shipment).
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

    // Keep the seller's Orders tab (orderStatus column) in step
    await syncOrderToSheet(order);

    await Notification.create({ recipient: order.customer, type: "order_shipped", title: "Out for Delivery", message: `Order ${order.orderNumber} is out for delivery`, data: { entityType: "order", entityId: order._id } });
    await Notification.create({ recipient: order.seller, type: "order_shipped", title: "Order Out for Delivery", message: `Order ${order.orderNumber} has been picked up by a delivery partner and is on its way to the customer.`, data: { entityType: "order", entityId: order._id } });
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

    // Keep the seller's Orders tab (orderStatus + paymentStatus) in step
    await syncOrderToSheet(order);

    // Update product stats (totalSold, totalRevenue) for each item
    for (const item of order.items) {
      await Product.findByIdAndUpdate(item.product, {
        $inc: { "stats.totalSold": item.quantity, "stats.totalRevenue": item.total },
      });
    }

    // For COD orders, update seller stats and credit wallet (online orders
    // are already handled by the payment-verification flow).
    if (order.payment.method === "cod") {
      const seller = await Seller.findById(order.seller);
      if (seller) {
        const grossAmount = order.total;
        const commissionPercent = seller.commissionRate || PLATFORM_COMMISSION_PERCENT;
        const platformFee = Math.round((grossAmount * commissionPercent) / 100);
        const sellerAmount = grossAmount - platformFee;

        let wallet = await Wallet.findOne({ seller: seller._id });
        if (!wallet) {
          wallet = new Wallet({ seller: seller._id, balance: 0, totalEarned: 0, totalWithdrawn: 0 });
        }
        wallet.balance += sellerAmount;
        wallet.totalEarned += sellerAmount;
        await wallet.save();

        await WalletTransaction.create({
          seller: seller._id,
          order: order._id,
          grossAmount,
          platformFee,
          sellerAmount,
          transactionType: "credit",
          status: "completed",
          description: `COD payment received for order ${order.orderNumber}`,
        });

        seller.stats.totalOrders += 1;
        seller.stats.totalRevenue += grossAmount;
        await seller.save();
      }
    }

    await Notification.create({ recipient: order.customer, type: "order_delivered", title: "Order Delivered", message: `Order ${order.orderNumber} has been delivered`, data: { entityType: "order", entityId: order._id } });
    await Notification.create({ recipient: order.seller, type: "order_delivered", title: "Order Delivered", message: `Order ${order.orderNumber} has been delivered`, data: { entityType: "order", entityId: order._id } });
    res.json({ success: true, message: "Order delivered", data: order });
});

// Helper to resolve seller's user ID for notifications
const getSellerUserId = async (sellerId) => {
    if (!sellerId) return null;
    const sellerDoc = await Seller.findById(sellerId).lean();
    if (sellerDoc?.user) return sellerDoc.user;
    return sellerId;
};

// -------------------------------------------------------------
// RETURN PICKUP & STORE RETURN ROUTES
// -------------------------------------------------------------

// Get active return pickups assigned to this delivery partner
router.get("/returns/active", async (req, res) => {
    const returns = await ReturnRequest.find({
        deliveryPartner: req.user._id,
        status: { $in: ["approved", "picked_up"] },
    })
      .sort({ updatedAt: -1 })
      .populate("customer", "name phone email address")
      .populate("seller", "businessName storeName phone address")
      .populate("order", "orderNumber shippingAddress")
      .populate("product", "title name images price")
      .lean();
    res.json({ success: true, data: returns });
});

// Browse available returns (approved, awaiting partner pickup assignment)
router.get("/returns/available", async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const filter = { status: "approved", deliveryPartner: null };
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [returns, total] = await Promise.all([
      ReturnRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate("customer", "name phone address")
        .populate("seller", "businessName storeName phone address")
        .populate("order", "orderNumber shippingAddress")
        .populate("product", "title name images price")
        .lean(),
      ReturnRequest.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: returns,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
});

// Accept an unassigned return pickup
router.put("/returns/:returnId/accept", async (req, res) => {
    const returnReq = await ReturnRequest.findById(req.params.returnId);
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });
    if (returnReq.status !== "approved") {
      return res.status(400).json({ success: false, message: `Cannot accept return in "${returnReq.status}" status` });
    }
    if (returnReq.deliveryPartner && returnReq.deliveryPartner.toString() !== req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "Return pickup already assigned to another partner" });
    }

    returnReq.deliveryPartner = req.user._id;
    returnReq.statusHistory.push({
      status: returnReq.status,
      note: `Delivery partner ${req.user.name || "assigned"} accepted return pickup`,
      changedBy: req.user._id,
    });
    await returnReq.save();

    res.json({ success: true, message: "Return pickup accepted", data: returnReq });
});

// Mark return package as picked up from customer
router.put("/returns/:returnId/pickup", async (req, res) => {
    const returnReq = await ReturnRequest.findById(req.params.returnId);
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });

    // Allow pickup if assigned or unassigned approved
    if (returnReq.deliveryPartner && returnReq.deliveryPartner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not assigned to this return pickup" });
    }
    if (!returnReq.deliveryPartner) {
      returnReq.deliveryPartner = req.user._id;
    }

    if (returnReq.status !== "approved") {
      return res.status(400).json({ success: false, message: `Cannot pick up return in "${returnReq.status}" status` });
    }

    returnReq.status = "picked_up";
    returnReq.pickedUpAt = new Date();
    returnReq.statusHistory.push({
      status: "picked_up",
      note: req.body.note || "Picked up from customer by delivery partner",
      changedBy: req.user._id,
    });
    await returnReq.save();

    // If there is an order, update order status if applicable
    if (returnReq.order) {
      const order = await Order.findById(returnReq.order);
      if (order) {
        order.status = "return_shipped";
        order.statusHistory.push({
          status: "return_shipped",
          note: `Return item picked up by delivery partner`,
          changedBy: req.user._id,
        });
        await order.save();

        // Keep the seller's Orders tab (orderStatus column) in step
        await syncOrderToSheet(order);
      }
    }

    // Notify Customer
    await Notification.create({
      recipient: returnReq.customer,
      type: "return_status",
      title: "Return Picked Up",
      message: `Your return item for Return #${returnReq._id.toString().slice(-6)} has been picked up by the delivery partner.`,
      data: { entityType: "return", entityId: returnReq._id },
    });

    // Notify Seller
    const sellerUserId = await getSellerUserId(returnReq.seller);
    if (sellerUserId) {
      await Notification.create({
        recipient: sellerUserId,
        type: "return_status",
        title: "Return Item Picked Up from Customer",
        message: `The delivery partner has picked up the return item for Return #${returnReq._id.toString().slice(-6)} from the customer and is en route to return it to your store.`,
        data: { entityType: "return", entityId: returnReq._id },
      });
    }

    res.json({ success: true, message: "Return package picked up from customer", data: returnReq });
});

// Mark return package as returned to store / seller
router.put("/returns/:returnId/return-to-store", async (req, res) => {
    const returnReq = await ReturnRequest.findById(req.params.returnId);
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });

    if (returnReq.deliveryPartner?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not assigned to this return pickup" });
    }
    if (returnReq.status !== "picked_up") {
      return res.status(400).json({ success: false, message: `Cannot mark returned to store from "${returnReq.status}" status. Must be picked up first.` });
    }

    returnReq.status = "returned_to_store";
    returnReq.returnedToStoreAt = new Date();
    returnReq.statusHistory.push({
      status: "returned_to_store",
      note: req.body.note || "Product delivered back to store / seller warehouse",
      changedBy: req.user._id,
    });
    await returnReq.save();

    // Notify Seller that item arrived at store
    const sellerUserId = await getSellerUserId(returnReq.seller);
    if (sellerUserId) {
      await Notification.create({
        recipient: sellerUserId,
        type: "return_status",
        title: "Returned Product Arrived at Store",
        message: `The delivery partner has returned the product for Return #${returnReq._id.toString().slice(-6)} to your store. Please inspect the product and confirm receipt to process the refund.`,
        data: { entityType: "return", entityId: returnReq._id },
      });
    }

    res.json({ success: true, message: "Product returned to store successfully", data: returnReq });
});

export default router;
