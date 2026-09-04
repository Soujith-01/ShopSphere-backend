import { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import Payment from "../../models/Payment.js";
import ParentOrder from "../../models/ParentOrder.js";
import Order from "../../models/Order.js";
import Wallet from "../../models/Wallet.js";
import WalletTransaction from "../../models/WalletTransaction.js";
import Cart from "../../models/Cart.js";
import Seller from "../../models/Seller.js";
import { protect } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect);

// Platform commission percentage (configurable via env, defaults to 5%)
const PLATFORM_COMMISSION_PERCENT = parseFloat(process.env.PLATFORM_COMMISSION_PERCENT || "5");

// Generate unique transaction ID: TXN_<timestamp>_<random>
const generateTransactionId = () => {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `TXN_${ts}_${rand}`;
};

// POST /api/payments/create
// Create a pending payment for an existing parent order.
// The amount is NEVER trusted from the frontend — always recalculated from DB.
router.post("/create", async (req, res) => {
  const { parentOrderId, paymentMethod } = req.body;

  // Validate parentOrderId
  if (!parentOrderId || !mongoose.Types.ObjectId.isValid(parentOrderId)) {
    return res.status(400).json({ success: false, message: "Valid parent order ID is required" });
  }

  // Validate payment method
  const allowedMethods = ["upi", "card", "net_banking"];
  if (!paymentMethod || !allowedMethods.includes(paymentMethod)) {
    return res.status(400).json({
      success: false,
      message: `Payment method must be one of: ${allowedMethods.join(", ")}`,
    });
  }

  // Fetch the parent order and verify ownership
  const parentOrder = await ParentOrder.findOne({
    _id: parentOrderId,
    customer: req.user._id,
  });

  if (!parentOrder) {
    return res.status(404).json({ success: false, message: "Parent order not found" });
  }

  // Prevent duplicate payment creation for already-paid orders
  if (parentOrder.payment.status === "completed") {
    return res.status(400).json({ success: false, message: "Order is already paid" });
  }

  // Recalculate the actual total from the database — never trust frontend amount
  const subOrders = await Order.find({ parentOrder: parentOrder._id });
  const recalculatedTotal = subOrders.reduce((sum, o) => sum + o.total, 0);

  // Create a Payment record
  const payment = new Payment({
    transactionId: generateTransactionId(),
    parentOrder: parentOrder._id,
    customer: req.user._id,
    amount: recalculatedTotal,
    currency: "INR",
    paymentMethod,
    status: "PENDING",
  });
  await payment.save();

  res.status(201).json({
    success: true,
    message: "Payment initiated",
    data: {
      transactionId: payment.transactionId,
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      status: payment.status,
    },
  });
});

// POST /api/payments/verify
// Accepts a transaction ID and a simulated result.
// Updates payment status, marks order as paid, credits seller wallets, clears cart.
router.post("/verify", async (req, res) => {
  const { transactionId, result } = req.body;

  // Validate transactionId
  if (!transactionId) {
    return res.status(400).json({ success: false, message: "Transaction ID is required" });
  }

  // Validate simulated result
  const allowedResults = ["SUCCESS", "FAILED", "CANCELLED"];
  if (!result || !allowedResults.includes(result)) {
    return res.status(400).json({
      success: false,
      message: `Result must be one of: ${allowedResults.join(", ")}`,
    });
  }

  // Find the payment
  const payment = await Payment.findOne({ transactionId });
  if (!payment) {
    return res.status(404).json({ success: false, message: "Payment not found" });
  }

  // Verify the customer owns this payment
  if (payment.customer.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: "Not authorized to verify this payment" });
  }

  // Prevent re-processing already completed payments
  if (payment.status === "SUCCESS") {
    return res.status(400).json({ success: false, message: "Payment already verified as successful" });
  }
  if (payment.status === "FAILED") {
    return res.status(400).json({ success: false, message: "Payment already failed" });
  }
  if (payment.status === "CANCELLED") {
    return res.status(400).json({ success: false, message: "Payment was cancelled and cannot be reprocessed" });
  }

  // Fetch parent order and sub-orders
  const parentOrder = await ParentOrder.findById(payment.parentOrder);
  if (!parentOrder) {
    return res.status(404).json({ success: false, message: "Parent order not found" });
  }

  const subOrders = await Order.find({ parentOrder: parentOrder._id });

  // Handle FAILED result
  if (result === "FAILED") {
    payment.status = "FAILED";
    payment.failureReason = "Simulated payment failure";
    await payment.save();

    return res.status(200).json({
      success: false,
      message: "Payment failed",
      data: {
        transactionId: payment.transactionId,
        status: payment.status,
        failureReason: payment.failureReason,
      },
    });
  }

  // Handle CANCELLED result
  if (result === "CANCELLED") {
    payment.status = "CANCELLED";
    await payment.save();

    return res.status(200).json({
      success: false,
      message: "Payment cancelled",
      data: {
        transactionId: payment.transactionId,
        status: payment.status,
      },
    });
  }

  // ─── SUCCESS path ───────────────────────────────────────────────────
  payment.status = "SUCCESS";
  await payment.save();

  // Update parent order payment status
  parentOrder.payment.status = "completed";
  parentOrder.payment.transactionId = payment.transactionId;
  parentOrder.payment.paidAt = new Date();
  parentOrder.status = "processing";
  await parentOrder.save();

  // Process each sub-order: update payment status, create seller orders, credit wallets
  for (const subOrder of subOrders) {
    // Update sub-order payment status
    subOrder.payment.status = "completed";
    subOrder.payment.transactionId = payment.transactionId;
    subOrder.payment.paidAt = new Date();
    await subOrder.save();

    // Fetch the seller to get their commission rate
    const seller = await Seller.findById(subOrder.seller);
    if (!seller) continue;

    const grossAmount = subOrder.total;
    const commissionPercent = seller.commissionRate || PLATFORM_COMMISSION_PERCENT;
    const platformFee = Math.round((grossAmount * commissionPercent) / 100);
    const sellerAmount = grossAmount - platformFee;

    // Create or update seller wallet
    let wallet = await Wallet.findOne({ seller: seller._id });
    if (!wallet) {
      wallet = new Wallet({ seller: seller._id, balance: 0, totalEarned: 0, totalWithdrawn: 0 });
    }
    wallet.balance += sellerAmount;
    wallet.totalEarned += sellerAmount;
    await wallet.save();

    // Record wallet transaction
    await WalletTransaction.create({
      seller: seller._id,
      parentOrder: parentOrder._id,
      order: subOrder._id,
      grossAmount,
      platformFee,
      sellerAmount,
      transactionType: "credit",
      status: "completed",
      description: `Payment received for order ${subOrder.orderNumber}`,
    });

    // Update seller stats
    seller.stats.totalOrders += 1;
    seller.stats.totalRevenue += grossAmount;
    await seller.save();
  }

  // Clear the customer's cart
  await Cart.findOneAndUpdate(
    { user: req.user._id },
    { items: [], subtotal: 0, totalItems: 0, coupon: null, couponCode: "", discountAmount: 0 }
  );

  // Build seller breakdown for response
  const sellerBreakdown = subOrders.map((o) => {
    const commissionPercent = PLATFORM_COMMISSION_PERCENT;
    const grossAmount = o.total;
    const platformFee = Math.round((grossAmount * commissionPercent) / 100);
    return {
      orderId: o._id,
      orderNumber: o.orderNumber,
      sellerId: o.seller,
      grossAmount,
      platformFee,
      sellerAmount: grossAmount - platformFee,
    };
  });

  res.status(200).json({
    success: true,
    message: "Payment verified successfully",
    data: {
      transactionId: payment.transactionId,
      parentOrderId: parentOrder._id,
      amount: payment.amount,
      status: payment.status,
      paidAt: payment.createdAt,
      sellerBreakdown,
    },
  });
});

// GET /api/payments/:transactionId
// Return payment details for the authenticated customer.
router.get("/:transactionId", async (req, res) => {
  const payment = await Payment.findOne({
    transactionId: req.params.transactionId,
    customer: req.user._id,
  }).populate("parentOrder", "total status payment");

  if (!payment) {
    return res.status(404).json({ success: false, message: "Payment not found" });
  }

  res.json({ success: true, data: payment });
});

export default router;
