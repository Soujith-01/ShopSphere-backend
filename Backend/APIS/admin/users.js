import { Router } from "express";
import User from "../../models/User.js";
import AuditLog from "../../models/AuditLog.js";
import Notification from "../../models/Notification.js";

const router = Router();

// Get user counts by role and active/inactive totals
router.get("/stats", async (req, res) => {
    const stats = await User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
    const total = await User.countDocuments();
    const active = await User.countDocuments({ isActive: true });
    res.json({ success: true, data: { total, active, inactive: total - active, byRole: stats } });
});

// List all users with filters (role, status, search by name/email/phone)
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, role, search, isActive } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) filter.$or = [{ name: { $regex: search, $options: "i" } }, { email: { $regex: search, $options: "i" } }, { phone: { $regex: search, $options: "i" } }];

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [users, total] = await Promise.all([
      User.find(filter).select("-password -refreshToken -passwordResetToken -passwordResetExpires").sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
      User.countDocuments(filter),
    ]);
    res.json({ success: true, data: users, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get single user detail
router.get("/:userId", async (req, res) => {
    const user = await User.findById(req.params.userId).select("-password -refreshToken -passwordResetToken -passwordResetExpires").lean();
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, data: user });
});

// Update user role, status, name, or phone
router.put("/:userId", async (req, res) => {
    const { role, isActive, name, phone } = req.body;
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const previousValues = { role: user.role, isActive: user.isActive };
    if (role) user.role = role;
    if (isActive !== undefined) user.isActive = isActive;
    if (name) user.name = name;
    if (phone !== undefined) user.phone = phone;
    await user.save({ validateModifiedOnly: true });

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "user.updated", entityType: "user", entityId: user._id, previousValues, newValues: { role: user.role, isActive: user.isActive }, description: `Admin updated user ${user.email}` });
    res.json({ success: true, data: { ...user.toJSON() } });
});

// Deactivate user account (revokes refresh token)
router.put("/:userId/deactivate", async (req, res) => {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    user.isActive = false;
    user.refreshToken = null;
    await user.save({ validateModifiedOnly: true });

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "user.deactivated", entityType: "user", entityId: user._id, description: `Admin deactivated user ${user.email}` });
    res.json({ success: true, message: "User deactivated" });
});

// Reactivate a deactivated user account
router.put("/:userId/activate", async (req, res) => {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    user.isActive = true;
    await user.save({ validateModifiedOnly: true });

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "user.activated", entityType: "user", entityId: user._id, description: `Admin reactivated user ${user.email}` });

    res.json({ success: true, message: "User reactivated", data: { ...user.toJSON() } });
});

export default router;
