import { Router } from "express";
import { body } from "express-validator";
import Seller from "../../models/Seller.js";
import Store from "../../models/Store.js";
import User from "../../models/User.js";
import AuditLog from "../../models/AuditLog.js";
import Notification from "../../models/Notification.js";
import { validate } from "../../middlewares/validateMiddleware.js";

const router = Router();

// List all sellers with filters
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, isVerified, status, search, isActive } = req.query;
    const filter = {};
    if (isVerified !== undefined) filter.isVerified = isVerified === "true";
    if (status) filter.status = status; // pending | approved | rejected
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

// Verify (approve) a seller — unlocks login + seller routes (triggers notification + audit log)
router.put("/:sellerId/verify", async (req, res) => {
    const seller = await Seller.findById(req.params.sellerId);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    seller.isVerified = true;
    seller.status = "approved";
    seller.rejectionReason = null;
    seller.rejectedAt = null;
    await seller.save();
    await User.findByIdAndUpdate(seller.user, { role: "seller" });

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "seller.verified", entityType: "seller", entityId: seller._id, description: `Admin approved seller "${seller.businessName}"` });
    await Notification.create({ recipient: seller.user, type: "seller_approved", title: "Seller Account Approved", message: "Your seller account has been approved. You can now log in and list products.", data: { entityType: "seller", entityId: seller._id } });

    res.json({ success: true, message: "Seller approved", data: seller });
});

// Reject a seller application — seller stays locked out of login + seller routes.
// A reason is stored and sent to the seller via notification + audit log.
router.put(
  "/:sellerId/reject",
  [
    body("reason")
      .trim()
      .notEmpty()
      .withMessage("A rejection reason is required")
      .isLength({ max: 500 })
      .withMessage("Reason must be at most 500 characters"),
  ],
  validate,
  async (req, res) => {
    const seller = await Seller.findById(req.params.sellerId);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    seller.isVerified = false;
    seller.status = "rejected";
    seller.rejectionReason = req.body.reason.trim();
    seller.rejectedAt = new Date();
    await seller.save();

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "seller.rejected", entityType: "seller", entityId: seller._id, description: `Admin rejected seller "${seller.businessName}" — ${seller.rejectionReason}` });
    await Notification.create({ recipient: seller.user, type: "seller_rejected", title: "Seller Application Rejected", message: `Your seller application for "${seller.businessName}" was rejected. Reason: ${seller.rejectionReason}`, data: { entityType: "seller", entityId: seller._id } });

    res.json({ success: true, message: "Seller application rejected", data: seller });
  }
);

// Deactivate a seller
router.put("/:sellerId/deactivate", async (req, res) => {
    const seller = await Seller.findById(req.params.sellerId);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    seller.isActive = false;
    await seller.save();

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "seller.deactivated", entityType: "seller", entityId: seller._id, description: `Admin deactivated seller "${seller.businessName}"` });
    res.json({ success: true, message: "Seller deactivated" });
});

// Reactivate a deactivated seller
router.put("/:sellerId/activate", async (req, res) => {
    const seller = await Seller.findById(req.params.sellerId);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    seller.isActive = true;
    await seller.save();

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "seller.activated", entityType: "seller", entityId: seller._id, description: `Admin reactivated seller "${seller.businessName}"` });
    await Notification.create({ recipient: seller.user, type: "seller_activated", title: "Seller Account Reactivated", message: `Your seller account "${seller.businessName}" has been reactivated. You can now log in and continue selling.`, data: { entityType: "seller", entityId: seller._id } });

    res.json({ success: true, message: "Seller reactivated", data: seller });
});

export default router;
