import { Router } from "express";
import mongoose from "mongoose";
import Cart from "../../models/Cart.js";
import Product from "../../models/Product.js";
import Variant from "../../models/Variant.js";
import Order from "../../models/Order.js";
import ParentOrder from "../../models/ParentOrder.js";
import Coupon from "../../models/Coupon.js";
import User from "../../models/User.js";
import Notification from "../../models/Notification.js";
import { generateOrderNumber } from "../../utils/helpers.js";
import { protect } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect);

// Get my parent orders (checkout-level grouped view)
router.get("/parents", async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Math.max(1, Number(limit)));

  const [orders, total] = await Promise.all([
    ParentOrder.find({ customer: req.user._id }).sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum).limit(limitNum)
      .populate({ path: "subOrders", select: "orderNumber status storeName total items",
        populate: { path: "seller", select: "businessName" },
      }).lean(),
    ParentOrder.countDocuments({ customer: req.user._id }),
  ]);

  res.json({ success: true, data: orders, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Checkout — creates parent order and splits into sub-orders per seller
router.post("/checkout", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { shippingAddressId, address, paymentMethod = "cod", couponCode, customerNote = "" } = req.body;

    const cart = await Cart.findOne({ user: req.user._id }).session(session);
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }

    // Determine shipping address from saved address or inline
    let shipAddr = address;
    if (shippingAddressId && !address) {
      const fullUser = await User.findById(req.user._id).session(session);
      shipAddr = fullUser.addresses.id(shippingAddressId);
      if (!shipAddr) return res.status(400).json({ success: false, message: "Address not found" });
      shipAddr = { fullName: shipAddr.fullName, phone: shipAddr.phone, street: shipAddr.street, pincode: shipAddr.pincode };
    }
    if (!shipAddr) return res.status(400).json({ success: false, message: "Shipping address required" });

    // Validate stock and group items by seller
    const sellerGroups = new Map();
    let cartSubtotal = 0;

    for (const item of cart.items) {
      const product = await Product.findById(item.product).session(session);
      if (!product || product.status !== "active") {
        return res.status(400).json({ success: false, message: `Product "${item.productName || item.product}" is unavailable` });
      }

      let variantDoc = null;
      if (item.variant) {
        variantDoc = await Variant.findById(item.variant).session(session);
        if (!variantDoc || !variantDoc.isActive) {
          return res.status(400).json({ success: false, message: `Variant unavailable for ${product.name}` });
        }
        if (item.quantity > variantDoc.availableStock) {
          return res.status(400).json({ success: false, message: `Insufficient stock for "${product.name}"` });
        }
      }

      const effectivePrice = variantDoc ? variantDoc.price : product.price;
      const total = effectivePrice * item.quantity;
      cartSubtotal += total;

      const orderItem = {
        product: product._id, variant: item.variant || null, productName: product.name,
        productImage: item.productImage || product.images?.[0]?.url || "",
        price: effectivePrice, quantity: item.quantity, discount: 0, tax: 0, total,
        variantLabel: variantDoc?.label || "", sku: variantDoc?.sku || "",
      };

      const sellerKey = product.seller.toString();
      if (!sellerGroups.has(sellerKey)) {
        sellerGroups.set(sellerKey, { seller: product.seller, store: product.store, storeName: "", items: [] });
      }
      sellerGroups.get(sellerKey).items.push(orderItem);

      if (variantDoc) { variantDoc.stock -= item.quantity; await variantDoc.save({ session }); }
    }

    // Apply coupon if provided
    let discount = 0;
    let couponDoc = null;
    if (couponCode) {
      couponDoc = await Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true }).session(session);
      if (!couponDoc) return res.status(400).json({ success: false, message: "Invalid coupon" });
      if (new Date() < couponDoc.validFrom || new Date() > couponDoc.validTo) return res.status(400).json({ success: false, message: "Coupon expired" });
      if (couponDoc.maxUsageTotal && couponDoc.usedCount >= couponDoc.maxUsageTotal) return res.status(400).json({ success: false, message: "Coupon usage limit reached" });
      if (couponDoc.minOrderAmount && cartSubtotal < couponDoc.minOrderAmount) return res.status(400).json({ success: false, message: `Minimum order ₹${couponDoc.minOrderAmount}` });

      discount = couponDoc.discountType === "percentage"
        ? Math.min((cartSubtotal * couponDoc.discountValue) / 100, couponDoc.maxDiscountAmount || Infinity)
        : Math.min(couponDoc.discountValue, cartSubtotal);
    }

    const finalTotal = cartSubtotal - discount;

    // Create parent order
    const parentOrder = new ParentOrder({
      customer: req.user._id, total: finalTotal, totalItems: cart.items.reduce((s, i) => s + i.quantity, 0),
      payment: { method: paymentMethod }, coupon: couponDoc?._id || null, discountAmount: discount,
      shippingAddress: shipAddr, customerNote, status: "processing",
    });
    await parentOrder.save({ session });

    // Create sub-orders per seller
    const subOrders = [];
    for (const [, group] of sellerGroups) {
      const sellerSubtotal = group.items.reduce((s, i) => s + i.total, 0);
      const sellerDiscount = cartSubtotal > 0 ? (sellerSubtotal / cartSubtotal) * discount : 0;

      const subOrder = new Order({
        customer: req.user._id, seller: group.seller, store: group.store, storeName: group.storeName,
        orderNumber: generateOrderNumber(), items: group.items, status: "placed",
        statusHistory: [{ status: "placed", note: "Order placed", changedBy: req.user._id }],
        subtotal: sellerSubtotal, shippingCost: 0, tax: 0, discount: sellerDiscount,
        total: sellerSubtotal - sellerDiscount,
        payment: { method: paymentMethod, status: paymentMethod === "cod" ? "pending" : "completed" },
        shippingAddress: shipAddr, customerNote, parentOrder: parentOrder._id,
      });
      await subOrder.save({ session });
      subOrders.push(subOrder);
    }

    parentOrder.subOrders = subOrders.map((o) => o._id);
    parentOrder.payment.status = paymentMethod === "cod" ? "pending" : "completed";
    if (paymentMethod !== "cod") parentOrder.payment.paidAt = new Date();
    await parentOrder.save({ session });

    if (couponDoc) { couponDoc.usedCount += 1; await couponDoc.save({ session }); }

    await Cart.findByIdAndUpdate(cart._id, { items: [], subtotal: 0, totalItems: 0, coupon: null, couponCode: "", discountAmount: 0 }, { session });

    for (const sub of subOrders) {
      await Notification.create([{ recipient: sub.seller, type: "order_placed", title: "New Order Received", message: `Order ${sub.orderNumber} has been placed`, data: { entityType: "order", entityId: sub._id } }], { session });
    }

    await session.commitTransaction();
    res.status(201).json({ success: true, message: "Order placed successfully", data: { parentOrder, subOrders } });
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});

// Get my orders with pagination
router.get("/", async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const filter = { customer: req.user._id };
  if (status) filter.status = status;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Math.max(1, Number(limit)));

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
      .populate("seller", "businessName").populate("store", "name slug logo").lean(),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: orders, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get single order detail with populated items
router.get("/:orderId", async (req, res) => {
  const order = await Order.findOne({ _id: req.params.orderId, customer: req.user._id })
    .populate("seller", "businessName").populate("store", "name slug logo")
    .populate("items.product", "name slug images").populate("items.variant", "label")
    .populate("deliveryPartner", "name phone").populate("parentOrder");

  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  res.json({ success: true, data: order });
});

// Cancel order (only allowed if placed or confirmed)
router.put("/:orderId/cancel", async (req, res) => {
  const { reason = "" } = req.body;
  const order = await Order.findOne({ _id: req.params.orderId, customer: req.user._id });
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  if (!["placed", "confirmed"].includes(order.status)) {
    return res.status(400).json({ success: false, message: `Cannot cancel order in "${order.status}" status` });
  }

  order.status = "cancelled";
  order.cancellationReason = reason;
  order.cancelledBy = req.user._id;
  order.statusHistory.push({ status: "cancelled", note: reason || "Cancelled by customer", changedBy: req.user._id });
  await order.save();

  for (const item of order.items) {
    if (item.variant) await Variant.findByIdAndUpdate(item.variant, { $inc: { stock: item.quantity } });
  }

  await Notification.create({ recipient: order.seller, type: "order_cancelled", title: "Order Cancelled", message: `Order ${order.orderNumber} has been cancelled`, data: { entityType: "order", entityId: order._id } });

  res.json({ success: true, message: "Order cancelled", data: order });
});

export default router;
