import { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import Payment from "../../models/Payment.js";
import ParentOrder from "../../models/ParentOrder.js";
import Order from "../../models/Order.js";
import Cart from "../../models/Cart.js";
import Product from "../../models/Product.js";
import Variant from "../../models/Variant.js";
import Coupon from "../../models/Coupon.js";
import User from "../../models/User.js";
import Seller from "../../models/Seller.js";
import Wallet from "../../models/Wallet.js";
import WalletTransaction from "../../models/WalletTransaction.js";
import Notification from "../../models/Notification.js";
import UserEvent from "../../models/UserEvent.js";
import { protect } from "../../middlewares/authMiddleware.js";
import { generateOrderNumber } from "../../utils/helpers.js";
import { syncProductToSheet } from "../../services/sheetSync.js";
import { syncOrdersToSheet } from "../../services/sheetOrders.js";
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  getRazorpayPayment,
  getRazorpayKeyId,
} from "../../services/razorpayService.js";

const router = Router();
router.use(protect);

// Platform commission percentage (configurable via env, defaults to 5%)
const PLATFORM_COMMISSION_PERCENT = parseFloat(
  process.env.PLATFORM_COMMISSION_PERCENT || "5"
);

// Generate unique transaction ID: TXN_<timestamp>_<random>
const generateTransactionId = () => {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `TXN_${ts}_${rand}`;
};

/**
 * GET /api/customer/payments/key
 * Return the public Razorpay Key ID for frontend initialization.
 */
router.get("/key", (req, res) => {
  const keyId = getRazorpayKeyId();
  res.json({
    success: true,
    data: { keyId },
  });
});

/**
 * POST /api/customer/payments/create-order
 * (Also supports /create-razorpay-order and /create-order)
 *
 * Backend validates cart & prices from MongoDB and creates a Razorpay Order.
 * NEVER trusts frontend prices, discounts, or totals.
 * DOES NOT deduct stock or clear cart yet.
 */
const handleCreatePaymentOrder = async (req, res) => {
  try {
    const {
      shippingAddressId,
      address,
      couponCode,
      customerNote = "",
      paymentMethod = "razorpay",
    } = req.body;

    // Fetch user cart
    const cart = await Cart.findOne({ user: req.user._id });
    if (!cart || !cart.items || cart.items.length === 0) {
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }

    // Determine and validate shipping address
    let shipAddr = address;
    if (shippingAddressId && !address) {
      const fullUser = await User.findById(req.user._id);
      shipAddr = fullUser?.addresses?.id(shippingAddressId);
      if (!shipAddr) {
        return res
          .status(400)
          .json({ success: false, message: "Selected shipping address not found" });
      }
      shipAddr = {
        fullName: shipAddr.fullName,
        phone: shipAddr.phone,
        street: shipAddr.street,
        pincode: shipAddr.pincode,
      };
    }
    if (!shipAddr || !shipAddr.fullName || !shipAddr.phone || !shipAddr.street || !shipAddr.pincode) {
      return res
        .status(400)
        .json({ success: false, message: "Valid shipping address is required" });
    }

    // Calculate real server-authoritative amount from MongoDB and validate stock
    let cartSubtotal = 0;

    for (const item of cart.items) {
      const product = await Product.findById(item.product);
      if (!product || product.status !== "active") {
        return res.status(400).json({
          success: false,
          message: `Product "${item.productName || item.product}" is currently unavailable`,
        });
      }

      let variantDoc = null;
      let availableStock = product.stock ?? 0;

      if (item.variant) {
        variantDoc = await Variant.findById(item.variant);
        if (!variantDoc || !variantDoc.isActive) {
          return res.status(400).json({
            success: false,
            message: `Variant unavailable for "${product.name}"`,
          });
        }
        availableStock =
          typeof variantDoc.availableStock === "number"
            ? variantDoc.availableStock
            : variantDoc.stock - (variantDoc.reservedStock || 0);
      }

      if (availableStock <= 0) {
        return res.status(400).json({
          success: false,
          message: `"${product.name}" is currently out of stock`,
        });
      }

      if (item.quantity > availableStock) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for "${product.name}". Only ${availableStock} item${
            availableStock === 1 ? "" : "s"
          } currently available.`,
        });
      }

      const effectivePrice = variantDoc ? variantDoc.price : product.price;
      cartSubtotal += effectivePrice * item.quantity;
    }

    // Apply coupon if provided
    let discount = 0;
    if (couponCode) {
      const couponDoc = await Coupon.findOne({
        code: couponCode.toUpperCase(),
        isActive: true,
      });

      if (!couponDoc) {
        return res.status(400).json({ success: false, message: "Invalid coupon code" });
      }

      const now = new Date();
      if (now < couponDoc.validFrom || now > couponDoc.validTo) {
        return res.status(400).json({ success: false, message: "Coupon has expired" });
      }

      if (couponDoc.maxUsageTotal && couponDoc.usedCount >= couponDoc.maxUsageTotal) {
        return res
          .status(400)
          .json({ success: false, message: "Coupon usage limit has been reached" });
      }

      if (couponDoc.minOrderAmount && cartSubtotal < couponDoc.minOrderAmount) {
        return res.status(400).json({
          success: false,
          message: `Minimum order amount for this coupon is ₹${couponDoc.minOrderAmount}`,
        });
      }

      discount =
        couponDoc.discountType === "percentage"
          ? Math.min(
              (cartSubtotal * couponDoc.discountValue) / 100,
              couponDoc.maxDiscountAmount || Infinity
            )
          : Math.min(couponDoc.discountValue, cartSubtotal);
    }

    const finalTotal = Math.max(1, cartSubtotal - discount);

    // Create Razorpay Order
    const receipt = `rcpt_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .substring(2, 7)}`;

    const razorpayOrder = await createRazorpayOrder({
      amount: finalTotal,
      currency: "INR",
      receipt,
      notes: {
        customerId: req.user._id.toString(),
        customerEmail: req.user.email || "",
        couponCode: couponCode || "",
      },
    });

    // Save pending Payment record in MongoDB
    const payment = new Payment({
      transactionId: razorpayOrder.id,
      razorpayOrderId: razorpayOrder.id,
      customer: req.user._id,
      amount: finalTotal,
      currency: "INR",
      paymentProvider: "razorpay",
      paymentMethod: paymentMethod || "razorpay",
      status: "PENDING",
    });
    await payment.save();

    res.status(201).json({
      success: true,
      message: "Razorpay order created successfully",
      data: {
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount, // in paise (e.g. 10000 = ₹100)
        amountInRupees: finalTotal,
        currency: razorpayOrder.currency || "INR",
        keyId: getRazorpayKeyId(),
        receipt: razorpayOrder.receipt,
      },
    });
  } catch (err) {
    console.error("[Razorpay Create Order Error]", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to create payment order",
    });
  }
};

router.post("/create-order", handleCreatePaymentOrder);
router.post("/create-razorpay-order", handleCreatePaymentOrder);

/**
 * POST /api/customer/payments/verify
 *
 * Verifies Razorpay HMAC signature & payment status.
 * ONLY after successful verification:
 *   1. Decrements product/variant stock atomically (concurrency-safe)
 *   2. Creates ShopSphere ParentOrder & sub-orders per seller (multi-vendor)
 *   3. Credits seller wallets
 *   4. Clears customer cart
 *   5. Synchronizes seller-specific Google Sheets Orders tab
 *   6. Sends seller notifications
 */
router.post("/verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      shippingAddressId,
      address,
      couponCode,
      customerNote = "",
      paymentMethod = "razorpay",
      // Legacy mock simulation compatibility fields:
      transactionId,
      result,
    } = req.body;

    // ─── Support legacy simulated mock verification (if no razorpay signature) ───
    if (!razorpay_signature && transactionId && result) {
      return handleLegacyMockVerification(req, res, { transactionId, result });
    }

    // ─── Razorpay Verification Workflow ──────────────────────────────────────────
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message:
          "Razorpay order ID, payment ID, and signature are required for payment verification",
      });
    }

    // 1. Signature Verification (HMAC SHA256)
    const isSignatureValid = verifyRazorpaySignature({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
    });

    if (!isSignatureValid) {
      await Payment.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        {
          status: "FAILED",
          failureReason: "Invalid Razorpay signature (tampering detected)",
          razorpayPaymentId: razorpay_payment_id,
        }
      );
      return res.status(400).json({
        success: false,
        message: "Payment signature verification failed. Tampering detected.",
      });
    }

    // 2. Double-click / Idempotency Check:
    // Prevent duplicate verification from creating multiple orders or reducing stock twice.
    const existingParent = await ParentOrder.findOne({
      $or: [
        { "payment.razorpayPaymentId": razorpay_payment_id },
        { "payment.razorpayOrderId": razorpay_order_id },
        { "payment.transactionId": razorpay_payment_id },
      ],
    }).populate("subOrders");

    if (existingParent) {
      return res.status(200).json({
        success: true,
        message: "Order has already been placed and verified",
        data: {
          parentOrder: existingParent,
          subOrders: existingParent.subOrders,
          alreadyProcessed: true,
        },
      });
    }

    // 3. Verify Payment Status with Razorpay API
    try {
      const rzpPayment = await getRazorpayPayment(razorpay_payment_id);
      if (!rzpPayment || rzpPayment.order_id !== razorpay_order_id) {
        return res.status(400).json({
          success: false,
          message: "Payment record mismatch with payment gateway",
        });
      }

      if (rzpPayment.status !== "captured" && rzpPayment.status !== "authorized") {
        await Payment.findOneAndUpdate(
          { razorpayOrderId: razorpay_order_id },
          {
            status: "FAILED",
            failureReason: `Razorpay payment status is ${rzpPayment.status}`,
            razorpayPaymentId: razorpay_payment_id,
          }
        );
        return res.status(400).json({
          success: false,
          message: `Payment not completed. Status: ${rzpPayment.status}`,
        });
      }
    } catch (rzpErr) {
      console.warn(
        "[Razorpay API Fetch Warning] Skipping direct fetch check:",
        rzpErr.message
      );
      // In case Razorpay API rate-limits or has network blip, signature was already cryptographically verified.
    }

    // 4. Fetch customer cart & validate items from MongoDB
    const cart = await Cart.findOne({ user: req.user._id });
    if (!cart || !cart.items || cart.items.length === 0) {
      // Check if order was already finalized right before
      const recentOrder = await ParentOrder.findOne({
        customer: req.user._id,
        "payment.razorpayOrderId": razorpay_order_id,
      }).populate("subOrders");

      if (recentOrder) {
        return res.status(200).json({
          success: true,
          message: "Order placed successfully",
          data: {
            parentOrder: recentOrder,
            subOrders: recentOrder.subOrders,
            alreadyProcessed: true,
          },
        });
      }

      return res.status(400).json({
        success: false,
        message: "Cart is empty. Order could not be created.",
      });
    }

    // Determine and validate shipping address
    let shipAddr = address;
    if (shippingAddressId && !address) {
      const fullUser = await User.findById(req.user._id);
      shipAddr = fullUser?.addresses?.id(shippingAddressId);
      if (!shipAddr) {
        return res
          .status(400)
          .json({ success: false, message: "Selected address not found" });
      }
      shipAddr = {
        fullName: shipAddr.fullName,
        phone: shipAddr.phone,
        street: shipAddr.street,
        pincode: shipAddr.pincode,
      };
    }
    if (!shipAddr || !shipAddr.fullName || !shipAddr.phone || !shipAddr.street || !shipAddr.pincode) {
      return res
        .status(400)
        .json({ success: false, message: "Valid shipping address is required" });
    }

    // Group items by seller & snapshot prices from MongoDB
    const sellerGroups = new Map();
    let cartSubtotal = 0;

    for (const item of cart.items) {
      const product = await Product.findById(item.product);
      if (!product || product.status !== "active") {
        return res.status(400).json({
          success: false,
          message: `Product "${item.productName || item.product}" is unavailable`,
        });
      }

      let variantDoc = null;
      let availableStock = product.stock ?? 0;

      if (item.variant) {
        variantDoc = await Variant.findById(item.variant);
        if (!variantDoc || !variantDoc.isActive) {
          return res.status(400).json({
            success: false,
            message: `Variant unavailable for ${product.name}`,
          });
        }
        availableStock =
          typeof variantDoc.availableStock === "number"
            ? variantDoc.availableStock
            : variantDoc.stock - (variantDoc.reservedStock || 0);
      }

      if (availableStock <= 0) {
        return res.status(400).json({
          success: false,
          message: `"${product.name}" is currently out of stock`,
        });
      }

      if (item.quantity > availableStock) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for "${product.name}". Only ${availableStock} item${
            availableStock === 1 ? "" : "s"
          } currently available.`,
        });
      }

      const effectivePrice = variantDoc ? variantDoc.price : product.price;
      const total = effectivePrice * item.quantity;
      cartSubtotal += total;

      const orderItem = {
        product: product._id,
        variant: item.variant || null,
        productName: product.name,
        productImage: item.productImage || product.images?.[0]?.url || "",
        price: effectivePrice,
        quantity: item.quantity,
        discount: 0,
        tax: 0,
        total,
        variantLabel: variantDoc?.label || "",
        sku: variantDoc?.sku || "",
      };

      const sellerKey = product.seller.toString();
      if (!sellerGroups.has(sellerKey)) {
        sellerGroups.set(sellerKey, {
          seller: product.seller,
          store: product.store,
          storeName: item.storeName || "",
          items: [],
        });
      }
      sellerGroups.get(sellerKey).items.push(orderItem);
    }

    // Coupon discount calculation
    let discount = 0;
    let couponDoc = null;
    if (couponCode) {
      couponDoc = await Coupon.findOne({
        code: couponCode.toUpperCase(),
        isActive: true,
      });

      if (couponDoc && new Date() >= couponDoc.validFrom && new Date() <= couponDoc.validTo) {
        if (!couponDoc.minOrderAmount || cartSubtotal >= couponDoc.minOrderAmount) {
          discount =
            couponDoc.discountType === "percentage"
              ? Math.min(
                  (cartSubtotal * couponDoc.discountValue) / 100,
                  couponDoc.maxDiscountAmount || Infinity
                )
              : Math.min(couponDoc.discountValue, cartSubtotal);
        }
      }
    }

    const finalTotal = Math.max(1, cartSubtotal - discount);

    // 5. Atomic Stock Deductions with Rollback on Conflict
    const appliedDeductions = [];
    for (const item of cart.items) {
      if (item.variant) {
        const updatedVariant = await Variant.findOneAndUpdate(
          { _id: item.variant, stock: { $gte: item.quantity }, isActive: true },
          { $inc: { stock: -item.quantity } },
          { new: true }
        );

        if (!updatedVariant) {
          // Rollback any previously applied deductions
          for (const d of appliedDeductions) {
            if (d.type === "variant") {
              await Variant.findByIdAndUpdate(d.id, { $inc: { stock: d.quantity } });
            } else {
              await Product.findByIdAndUpdate(d.id, {
                $inc: { stock: d.quantity, "stats.totalSold": -d.quantity },
              });
            }
          }
          return res.status(400).json({
            success: false,
            message: `Variant stock ran out for "${item.productName}". Please try again.`,
          });
        }

        // Mirror the variant's new stock to seller sheet
        try {
          await syncProductToSheet(item.product);
        } catch {
          /* best effort */
        }
        appliedDeductions.push({
          type: "variant",
          id: item.variant,
          quantity: item.quantity,
        });
      } else {
        const updatedProduct = await Product.findOneAndUpdate(
          { _id: item.product, stock: { $gte: item.quantity }, status: "active" },
          { $inc: { stock: -item.quantity, "stats.totalSold": item.quantity } },
          { new: true }
        );

        if (!updatedProduct) {
          // Rollback any previously applied deductions
          for (const d of appliedDeductions) {
            if (d.type === "variant") {
              await Variant.findByIdAndUpdate(d.id, { $inc: { stock: d.quantity } });
            } else {
              await Product.findByIdAndUpdate(d.id, {
                $inc: { stock: d.quantity, "stats.totalSold": -d.quantity },
              });
            }
          }
          return res.status(400).json({
            success: false,
            message: `Stock ran out for "${item.productName}". Please try again.`,
          });
        }

        // Mirror the product's new stock to seller sheet
        try {
          await syncProductToSheet(updatedProduct);
        } catch {
          /* best effort */
        }
        appliedDeductions.push({
          type: "product",
          id: item.product,
          quantity: item.quantity,
        });
      }
    }

    // 6. Create Parent Order
    const parentOrder = new ParentOrder({
      customer: req.user._id,
      total: finalTotal,
      totalItems: cart.items.reduce((s, i) => s + i.quantity, 0),
      payment: {
        method: paymentMethod || "razorpay",
        status: "completed",
        paymentProvider: "razorpay",
        transactionId: razorpay_payment_id,
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        paidAt: new Date(),
      },
      coupon: couponDoc?._id || null,
      discountAmount: discount,
      shippingAddress: shipAddr,
      customerNote,
      status: "processing",
    });
    await parentOrder.save();

    // 7. Create sub-orders per seller (Multi-vendor splitting)
    const subOrders = [];
    for (const [, group] of sellerGroups) {
      const sellerSubtotal = group.items.reduce((s, i) => s + i.total, 0);
      const sellerDiscount =
        cartSubtotal > 0 ? (sellerSubtotal / cartSubtotal) * discount : 0;
      const sellerFinalTotal = Math.max(0, sellerSubtotal - sellerDiscount);

      const subOrder = new Order({
        customer: req.user._id,
        seller: group.seller,
        store: group.store,
        storeName: group.storeName,
        orderNumber: generateOrderNumber(),
        items: group.items,
        status: "placed",
        statusHistory: [
          {
            status: "placed",
            note: "Order placed and paid via Razorpay",
            changedBy: req.user._id,
          },
        ],
        subtotal: sellerSubtotal,
        shippingCost: 0,
        tax: 0,
        discount: sellerDiscount,
        total: sellerFinalTotal,
        payment: {
          method: paymentMethod || "razorpay",
          status: "completed",
          paymentProvider: "razorpay",
          transactionId: razorpay_payment_id,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          paidAt: new Date(),
        },
        shippingAddress: shipAddr,
        customerNote,
        parentOrder: parentOrder._id,
      });

      await subOrder.save();
      subOrders.push(subOrder);

      // Credit seller wallet for online payment
      try {
        const sellerDoc = await Seller.findById(group.seller);
        if (sellerDoc) {
          const commissionPercent =
            sellerDoc.commissionRate || PLATFORM_COMMISSION_PERCENT;
          const platformFee = Math.round(
            (sellerFinalTotal * commissionPercent) / 100
          );
          const sellerAmount = sellerFinalTotal - platformFee;

          let wallet = await Wallet.findOne({ seller: sellerDoc._id });
          if (!wallet) {
            wallet = new Wallet({
              seller: sellerDoc._id,
              balance: 0,
              totalEarned: 0,
              totalWithdrawn: 0,
            });
          }
          wallet.balance += sellerAmount;
          wallet.totalEarned += sellerAmount;
          await wallet.save();

          await WalletTransaction.create({
            seller: sellerDoc._id,
            parentOrder: parentOrder._id,
            order: subOrder._id,
            grossAmount: sellerFinalTotal,
            platformFee,
            sellerAmount,
            transactionType: "credit",
            status: "completed",
            description: `Payment received for order ${subOrder.orderNumber} via Razorpay`,
          });

          sellerDoc.stats.totalOrders = (sellerDoc.stats.totalOrders || 0) + 1;
          sellerDoc.stats.totalRevenue =
            (sellerDoc.stats.totalRevenue || 0) + sellerFinalTotal;
          await sellerDoc.save();
        }
      } catch (walletErr) {
        console.error(
          `[Wallet Credit Error for seller ${group.seller}]`,
          walletErr.message
        );
      }
    }

    parentOrder.subOrders = subOrders.map((o) => o._id);
    await parentOrder.save();

    // Increment coupon usage count
    if (couponDoc) {
      couponDoc.usedCount = (couponDoc.usedCount || 0) + 1;
      await couponDoc.save();
    }

    // Clear customer cart
    await Cart.findByIdAndUpdate(cart._id, {
      items: [],
      subtotal: 0,
      totalItems: 0,
      coupon: null,
      couponCode: "",
      discountAmount: 0,
    });

    // Update / upsert Payment model
    await Payment.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id },
      {
        transactionId: razorpay_payment_id,
        parentOrder: parentOrder._id,
        customer: req.user._id,
        amount: finalTotal,
        currency: "INR",
        paymentProvider: "razorpay",
        paymentMethod: paymentMethod || "razorpay",
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        status: "SUCCESS",
      },
      { upsert: true, new: true }
    );

    // Notify sellers
    for (const sub of subOrders) {
      Notification.create({
        recipient: sub.seller,
        type: "order_placed",
        title: "New Order Received (Paid)",
        message: `Order ${sub.orderNumber} has been placed and paid via Razorpay`,
        data: { entityType: "order", entityId: sub._id },
      }).catch(() => {});
    }

    // Mirror to seller-specific Google Sheets (Best-effort: failures never break order confirmation)
    try {
      await syncOrdersToSheet(subOrders);
    } catch (sheetErr) {
      console.error("[Google Sheets Sync Error on Checkout]", sheetErr.message);
    }

    // Log PURCHASE events for AI recommendations
    for (const item of cart.items) {
      UserEvent.create({
        userId: req.user._id,
        productId: item.product,
        eventType: "PURCHASE",
        metadata: { quantity: item.quantity, parentOrder: parentOrder._id },
      }).catch(() => {});
    }

    res.status(200).json({
      success: true,
      message: "Payment verified and order placed successfully",
      data: {
        parentOrder,
        subOrders,
        payment: {
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          status: "completed",
        },
      },
    });
  } catch (err) {
    console.error("[Razorpay Verify Error]", err);
    res.status(500).json({
      success: false,
      message: err.message || "Payment verification failed",
    });
  }
});

/**
 * POST /api/customer/payments/failure
 * Record Razorpay payment cancellation or failure from frontend.
 * DOES NOT deduct stock, DOES NOT clear cart.
 */
router.post("/failure", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      failureReason = "Payment failed or cancelled by user",
    } = req.body;

    if (razorpay_order_id) {
      await Payment.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        {
          status: "FAILED",
          failureReason,
          razorpayPaymentId: razorpay_payment_id || "",
        }
      );
    }

    res.json({
      success: true,
      message: "Payment failure recorded. Cart remains saved.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/customer/payments/create
 * Legacy endpoint support for existing parent order simulation
 */
router.post("/create", async (req, res) => {
  const { parentOrderId, paymentMethod = "upi" } = req.body;

  if (!parentOrderId || !mongoose.Types.ObjectId.isValid(parentOrderId)) {
    return res
      .status(400)
      .json({ success: false, message: "Valid parent order ID is required" });
  }

  const parentOrder = await ParentOrder.findOne({
    _id: parentOrderId,
    customer: req.user._id,
  });

  if (!parentOrder) {
    return res.status(404).json({ success: false, message: "Parent order not found" });
  }

  if (parentOrder.payment.status === "completed" || parentOrder.payment.status === "paid") {
    return res.status(400).json({ success: false, message: "Order is already paid" });
  }

  const subOrders = await Order.find({ parentOrder: parentOrder._id });
  const recalculatedTotal = subOrders.reduce((sum, o) => sum + o.total, 0);

  const payment = new Payment({
    transactionId: generateTransactionId(),
    parentOrder: parentOrder._id,
    customer: req.user._id,
    amount: recalculatedTotal,
    currency: "INR",
    paymentProvider: "razorpay",
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

// Helper for legacy simulated verification
async function handleLegacyMockVerification(req, res, { transactionId, result }) {
  const payment = await Payment.findOne({ transactionId });
  if (!payment) {
    return res.status(404).json({ success: false, message: "Payment not found" });
  }

  if (payment.customer.toString() !== req.user._id.toString()) {
    return res
      .status(403)
      .json({ success: false, message: "Not authorized to verify this payment" });
  }

  if (payment.status === "SUCCESS") {
    return res
      .status(400)
      .json({ success: false, message: "Payment already verified as successful" });
  }

  if (result === "FAILED") {
    payment.status = "FAILED";
    payment.failureReason = "Simulated payment failure";
    await payment.save();
    return res.status(200).json({
      success: false,
      message: "Payment failed",
      data: { transactionId: payment.transactionId, status: payment.status },
    });
  }

  if (result === "CANCELLED") {
    payment.status = "CANCELLED";
    await payment.save();
    return res.status(200).json({
      success: false,
      message: "Payment cancelled",
      data: { transactionId: payment.transactionId, status: payment.status },
    });
  }

  payment.status = "SUCCESS";
  await payment.save();

  if (payment.parentOrder) {
    const parentOrder = await ParentOrder.findById(payment.parentOrder);
    if (parentOrder) {
      parentOrder.payment.status = "completed";
      parentOrder.payment.transactionId = payment.transactionId;
      parentOrder.payment.paidAt = new Date();
      await parentOrder.save();

      const subOrders = await Order.find({ parentOrder: parentOrder._id });
      for (const subOrder of subOrders) {
        subOrder.payment.status = "completed";
        subOrder.payment.transactionId = payment.transactionId;
        subOrder.payment.paidAt = new Date();
        await subOrder.save();

        const seller = await Seller.findById(subOrder.seller);
        if (seller) {
          const grossAmount = subOrder.total;
          const commissionPercent =
            seller.commissionRate || PLATFORM_COMMISSION_PERCENT;
          const platformFee = Math.round((grossAmount * commissionPercent) / 100);
          const sellerAmount = grossAmount - platformFee;

          let wallet = await Wallet.findOne({ seller: seller._id });
          if (!wallet) {
            wallet = new Wallet({
              seller: seller._id,
              balance: 0,
              totalEarned: 0,
              totalWithdrawn: 0,
            });
          }
          wallet.balance += sellerAmount;
          wallet.totalEarned += sellerAmount;
          await wallet.save();

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

          seller.stats.totalOrders += 1;
          seller.stats.totalRevenue += grossAmount;
          await seller.save();
        }
      }
    }
  }

  await Cart.findOneAndUpdate(
    { user: req.user._id },
    {
      items: [],
      subtotal: 0,
      totalItems: 0,
      coupon: null,
      couponCode: "",
      discountAmount: 0,
    }
  );

  res.status(200).json({
    success: true,
    message: "Payment verified successfully",
    data: {
      transactionId: payment.transactionId,
      amount: payment.amount,
      status: payment.status,
    },
  });
}

/**
 * GET /api/customer/payments/:transactionId
 */
router.get("/:transactionId", async (req, res) => {
  const payment = await Payment.findOne({
    $or: [
      { transactionId: req.params.transactionId },
      { razorpayOrderId: req.params.transactionId },
      { razorpayPaymentId: req.params.transactionId },
    ],
    customer: req.user._id,
  }).populate("parentOrder", "total status payment");

  if (!payment) {
    return res.status(404).json({ success: false, message: "Payment not found" });
  }

  res.json({ success: true, data: payment });
});

export default router;
