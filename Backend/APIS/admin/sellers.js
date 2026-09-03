import { Router } from "express";
import Seller from "../../models/Seller.js";
import Store from "../../models/Store.js";
import User from "../../models/User.js";
import AuditLog from "../../models/AuditLog.js";
import Notification from "../../models/Notification.js";

const router = Router();

// List all sellers with filters
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, isVerified, search, isActive } = req.query;
    const filter = {};
    if (isVerified !== undefined) filter.isVerified = isVerified === "true";
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.$or = [{ businessName: { $regex: search, $options: "i" } }];

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [sellers, total] = await Promise.all([
      Seller.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).populate("user", "name email phone avatar").lean(),
      Seller.countDocuments(filter),
    ]);
    res.json({ success: true, data: sellers, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get single seller detail with store info
router.get("/:sellerId", async (req, res) => {
    const seller = await Seller.findById(req.params.sellerId).populate("user", "name email phone avatar").lean();
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });
    const store = await Store.findOne({ seller: seller._id }).lean();
    res.json({ success: true, data: { ...seller, store } });
});

// Verify a seller (triggers notification + audit log)
router.put("/:sellerId/verify", async (req, res) => {
    const seller = await Seller.findById(req.params.sellerId);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    seller.isVerified = true;
    await seller.save();
    await User.findByIdAndUpdate(seller.user, { role: "seller" });

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "seller.verified", entityType: "seller", entityId: seller._id, description: `Admin verified seller "${seller.businessName}"` });
    await Notification.create({ recipient: seller.user, type: "seller_approved", title: "Seller Account Verified", message: "Your seller account has been verified. You can now list products.", data: { entityType: "seller", entityId: seller._id } });

    res.json({ success: true, message: "Seller verified", data: seller });
});

// Deactivate a seller
router.put("/:sellerId/deactivate", async (req, res) => {
    const seller = await Seller.findById(req.params.sellerId);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    seller.isActive = false;
    await seller.save();

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "seller.deactivated", entityType: "seller", entityId: seller._id, description: `Admin deactivated seller "${seller.businessName}"` });
    res.json({ success: true, message: "Seller deactivated" });
});

export default router;
