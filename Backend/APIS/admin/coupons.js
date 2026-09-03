import { Router } from "express";
import Coupon from "../../models/Coupon.js";

const router = Router();

// List all coupons with filters
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, isActive, scope } = req.query;
    const filter = {};
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (scope) filter.scope = scope;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [coupons, total] = await Promise.all([
      Coupon.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).populate("createdBy", "name email").lean(),
      Coupon.countDocuments(filter),
    ]);
    res.json({ success: true, data: coupons, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Create a new coupon (platform/seller/category/product scoped)
router.post("/", async (req, res) => {
    const { code, description, discountType, discountValue, maxDiscountAmount, minOrderAmount, maxUsageTotal, maxUsagePerUser, validFrom, validTo, scope, applicableSellers, applicableCategories, applicableProducts } = req.body;
    if (!code || !discountType || !discountValue || !validFrom || !validTo) return res.status(400).json({ success: false, message: "code, discountType, discountValue, validFrom, and validTo are required" });

    const existingCode = await Coupon.findOne({ code: code.toUpperCase() });
    if (existingCode) return res.status(400).json({ success: false, message: "Coupon code already exists" });

    const coupon = await Coupon.create({
      code: code.toUpperCase(), description: description || "", discountType, discountValue: Number(discountValue),
      maxDiscountAmount: maxDiscountAmount || null, minOrderAmount: Number(minOrderAmount) || 0,
      maxUsageTotal: maxUsageTotal || null, maxUsagePerUser: Number(maxUsagePerUser) || 1,
      validFrom: new Date(validFrom), validTo: new Date(validTo), scope: scope || "platform",
      applicableSellers: applicableSellers || [], applicableCategories: applicableCategories || [], applicableProducts: applicableProducts || [],
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, data: coupon });
});

// Update coupon details
router.put("/:couponId", async (req, res) => {
    const coupon = await Coupon.findById(req.params.couponId);
    if (!coupon) return res.status(404).json({ success: false, message: "Coupon not found" });

    const disallowed = ["createdBy", "usedCount"];
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) { if (!disallowed.includes(key) && value !== undefined) updates[key] = value; }
    if (updates.code) updates.code = updates.code.toUpperCase();

    const updated = await Coupon.findByIdAndUpdate(req.params.couponId, updates, { new: true, runValidators: true });
    res.json({ success: true, data: updated });
});

// Toggle coupon active/inactive status
router.put("/:couponId/toggle", async (req, res) => {
    const coupon = await Coupon.findById(req.params.couponId);
    if (!coupon) return res.status(404).json({ success: false, message: "Coupon not found" });

    coupon.isActive = !coupon.isActive;
    await coupon.save();
    res.json({ success: true, message: `Coupon ${coupon.isActive ? "activated" : "deactivated"}`, data: coupon });
});

// Delete a coupon
router.delete("/:couponId", async (req, res) => {
    const coupon = await Coupon.findById(req.params.couponId);
    if (!coupon) return res.status(404).json({ success: false, message: "Coupon not found" });
    await coupon.deleteOne();
    res.json({ success: true, message: "Coupon deleted" });
});

export default router;
