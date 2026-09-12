import { Router } from "express";
import { body } from "express-validator";
import User from "../../models/User.js";
import AuditLog from "../../models/AuditLog.js";
import Notification from "../../models/Notification.js";
import cloudinary from "../../config/cloudinary.js";
import { validate } from "../../middlewares/validateMiddleware.js";

const router = Router();

// Delivery-agent applications and accounts. Registration happens on the public
// /api/auth/register endpoint (role "delivery") which stores vehicle details +
// a driving-license photo on user.deliveryPartner with verificationStatus
// "pending". The routes below let admins review those details and unlock or
// lock the account.

// Helper: list users who registered as delivery agents
const deliveryFilter = { role: "delivery" };

// List delivery agents with filters (?status=pending|approved|rejected, ?search, ?isActive)
router.get("/", async (req, res) => {
    const { status, search, isActive } = req.query;
    const filter = { ...deliveryFilter };
    if (status) filter["deliveryPartner.verificationStatus"] = status;
    if (isActive !== undefined) filter.isActive = isActive === "true";
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { "deliveryPartner.vehicleNumber": { $regex: search, $options: "i" } },
      ];
    }

    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [agents, total] = await Promise.all([
      User.find(filter)
        .select("-password -refreshToken -passwordResetToken -passwordResetExpires")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      User.countDocuments(filter),
    ]);
    res.json({ success: true, data: agents, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get one delivery agent's full application details (documents included)
router.get("/:userId", async (req, res) => {
    const agent = await User.findOne({ _id: req.params.userId, ...deliveryFilter })
      .select("-password -refreshToken -passwordResetToken -passwordResetExpires")
      .lean();
    if (!agent) return res.status(404).json({ success: false, message: "Delivery agent not found" });
    res.json({ success: true, data: agent });
});

// Approve a delivery agent — unlocks login and delivery routes.
router.put("/:userId/verify", async (req, res) => {
    const agent = await User.findOne({ _id: req.params.userId, ...deliveryFilter });
    if (!agent) return res.status(404).json({ success: false, message: "Delivery agent not found" });

    if (agent.deliveryPartner?.verificationStatus === "approved") {
      return res.status(400).json({ success: false, message: "Delivery agent is already approved" });
    }

    agent.deliveryPartner.verificationStatus = "approved";
    agent.deliveryPartner.rejectionReason = "";
    agent.deliveryPartner.verifiedAt = new Date();
    await agent.save({ validateModifiedOnly: true });

    await AuditLog.create({
      actor: req.user._id,
      actorRole: "admin",
      action: "delivery_partner.verified",
      entityType: "delivery_partner",
      entityId: agent._id,
      description: `Admin approved delivery agent "${agent.name}" (${agent.email})`,
    });
    await Notification.create({
      recipient: agent._id,
      type: "delivery_approved",
      title: "Delivery Partner Application Approved",
      message: "Your documents have been verified. You can now log in and start accepting deliveries.",
      data: { entityType: "user", entityId: agent._id },
    });

    res.json({ success: true, message: "Delivery agent approved", data: agent.toJSON() });
});

// Reject a delivery agent application — login stays blocked; a reason is
// required and is shown to the agent when they try to log in.
router.put(
  "/:userId/reject",
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
    const agent = await User.findOne({ _id: req.params.userId, ...deliveryFilter });
    if (!agent) return res.status(404).json({ success: false, message: "Delivery agent not found" });

    if (agent.deliveryPartner?.verificationStatus === "rejected") {
      return res.status(400).json({ success: false, message: "Delivery agent is already rejected" });
    }

    agent.deliveryPartner.verificationStatus = "rejected";
    agent.deliveryPartner.rejectionReason = req.body.reason.trim();
    agent.deliveryPartner.isAvailable = false;
    await agent.save({ validateModifiedOnly: true });

    await AuditLog.create({
      actor: req.user._id,
      actorRole: "admin",
      action: "delivery_partner.rejected",
      entityType: "delivery_partner",
      entityId: agent._id,
      description: `Admin rejected delivery agent "${agent.name}" (${agent.email}) — ${agent.deliveryPartner.rejectionReason}`,
    });
    await Notification.create({
      recipient: agent._id,
      type: "delivery_rejected",
      title: "Delivery Partner Application Rejected",
      message: `Your delivery partner application was rejected. Reason: ${agent.deliveryPartner.rejectionReason}`,
      data: { entityType: "user", entityId: agent._id },
    });

    res.json({ success: true, message: "Delivery agent application rejected", data: agent.toJSON() });
  }
);

// Suspend an approved agent — revokes their session token so they're logged
// out everywhere and can't log back in until re-approved.
router.put("/:userId/deactivate", async (req, res) => {
    const agent = await User.findOne({ _id: req.params.userId, ...deliveryFilter });
    if (!agent) return res.status(404).json({ success: false, message: "Delivery agent not found" });

    agent.isActive = false;
    agent.refreshToken = null;
    agent.deliveryPartner.isAvailable = false;
    await agent.save({ validateModifiedOnly: true });

    await AuditLog.create({
      actor: req.user._id,
      actorRole: "admin",
      action: "delivery_partner.deactivated",
      entityType: "delivery_partner",
      entityId: agent._id,
      description: `Admin deactivated delivery agent "${agent.name}" (${agent.email})`,
    });

    res.json({ success: true, message: "Delivery agent deactivated" });
});

// Reinstate a suspended agent.
router.put("/:userId/activate", async (req, res) => {
    const agent = await User.findOne({ _id: req.params.userId, ...deliveryFilter });
    if (!agent) return res.status(404).json({ success: false, message: "Delivery agent not found" });

    agent.isActive = true;
    await agent.save({ validateModifiedOnly: true });

    await AuditLog.create({
      actor: req.user._id,
      actorRole: "admin",
      action: "delivery_partner.activated",
      entityType: "delivery_partner",
      entityId: agent._id,
      description: `Admin reactivated delivery agent "${agent.name}" (${agent.email})`,
    });

    res.json({ success: true, message: "Delivery agent reactivated", data: agent.toJSON() });
});

// Delete a rejected application entirely (GDPR-style cleanup). Removes the
// user account and the license photo from Cloudinary.
router.delete("/:userId", async (req, res) => {
    const agent = await User.findOne({ _id: req.params.userId, ...deliveryFilter });
    if (!agent) return res.status(404).json({ success: false, message: "Delivery agent not found" });

    if (agent.deliveryPartner?.verificationStatus !== "rejected") {
      return res.status(400).json({ success: false, message: 'Only rejected applications can be deleted' });
    }

    const publicId = agent.deliveryPartner?.licensePhoto?.publicId;
    if (publicId) {
      try {
        await cloudinary.uploader.destroy(publicId);
      } catch (err) {
        // Photo cleanup is best-effort — don't block the deletion.
        console.warn(`[AdminDelivery] Failed to delete license photo ${publicId}: ${err.message}`);
      }
    }

    await User.deleteOne({ _id: agent._id });
    await AuditLog.create({
      actor: req.user._id,
      actorRole: "admin",
      action: "delivery_partner.deleted",
      entityType: "delivery_partner",
      entityId: agent._id,
      description: `Admin deleted rejected delivery agent application "${agent.name}" (${agent.email})`,
    });

    res.json({ success: true, message: "Delivery agent application deleted" });
});

export default router;
