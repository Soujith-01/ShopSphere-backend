import { Router } from "express";
import Coupon from "../../models/Coupon.js";
import Cart from "../../models/Cart.js";
import { protect } from "../../middlewares/authMiddleware.js";

const router = Router();

// Validate a coupon code and preview discount amount
router.post("/validate", protect, async (req, res) => {
    const { code, subtotal } = req.body;
    if (!code) return res.status(400).json({ success: false, message: "Coupon code required" });

    const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
    if (!coupon) return res.status(404).json({ success: false, message: "Invalid coupon code" });

    const now = new Date();
    if (now < coupon.validFrom || now > coupon.validTo) return res.status(400).json({ success: false, message: "Coupon has expired" });
    if (coupon.maxUsageTotal && coupon.usedCount >= coupon.maxUsageTotal) return res.status(400).json({ success: false, message: "Coupon usage limit reached" });

    const orderAmount = subtotal || 0;
    if (coupon.minOrderAmount && orderAmount < coupon.minOrderAmount) {
      return res.status(400).json({ success: false, message: `Minimum order amount ₹${coupon.minOrderAmount} required` });
    }

    let discount = 0;
    if (coupon.discountType === "percentage") {
      discount = (orderAmount * coupon.discountValue) / 100;
      if (coupon.maxDiscountAmount) discount = Math.min(discount, coupon.maxDiscountAmount);
    } else {
      discount = Math.min(coupon.discountValue, orderAmount);
    }

    res.json({ success: true, data: { code: coupon.code, description: coupon.description, discountType: coupon.discountType, discountValue: coupon.discountValue, calculatedDiscount: +discount.toFixed(2) } });
});

// Apply coupon to user's cart
router.post("/apply", protect, async (req, res) => {
    const { code } = req.body;
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
    if (!coupon) return res.status(404).json({ success: false, message: "Invalid coupon code" });

    const now = new Date();
    if (now < coupon.validFrom || now > coupon.validTo) return res.status(400).json({ success: false, message: "Coupon has expired" });
    if (coupon.maxUsageTotal && coupon.usedCount >= coupon.maxUsageTotal) return res.status(400).json({ success: false, message: "Coupon usage limit reached" });

    const cart = await Cart.findOne({ user: req.user._id });
    if (!cart || cart.items.length === 0) return res.status(400).json({ success: false, message: "Cart is empty" });
    if (coupon.minOrderAmount && cart.subtotal < coupon.minOrderAmount) {
      return res.status(400).json({ success: false, message: `Minimum order amount ₹${coupon.minOrderAmount} required` });
    }

    let discount = 0;
    if (coupon.discountType === "percentage") {
      discount = (cart.subtotal * coupon.discountValue) / 100;
      if (coupon.maxDiscountAmount) discount = Math.min(discount, coupon.maxDiscountAmount);
    } else {
      discount = Math.min(coupon.discountValue, cart.subtotal);
    }

    cart.coupon = coupon._id;
    cart.couponCode = coupon.code;
    cart.discountAmount = +discount.toFixed(2);
    await cart.save();

    res.json({ success: true, message: "Coupon applied", data: { couponCode: coupon.code, discount: +discount.toFixed(2), subtotal: cart.subtotal, total: +(cart.subtotal - discount).toFixed(2) } });
});

// Remove coupon from cart
router.delete("/remove", protect, async (req, res) => {
    await Cart.findOneAndUpdate({ user: req.user._id }, { coupon: null, couponCode: "", discountAmount: 0 });
    res.json({ success: true, message: "Coupon removed" });
});

export default router;
