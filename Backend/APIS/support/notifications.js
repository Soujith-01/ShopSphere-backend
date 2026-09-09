import { Router } from "express";
import Notification from "../../models/Notification.js";

// Notifications for the logged-in support agent (ticket assignments,
// customer replies, escalations). Recipient is the User doc, same as admins.
const router = Router();

// Get notifications for this support agent with unread count
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, unreadOnly } = req.query;
    const filter = { recipient: req.user._id };
    if (unreadOnly === "true") filter.isRead = false;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ recipient: req.user._id, isRead: false }),
    ]);

    res.json({
      success: true,
      data: { notifications, unreadCount },
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
});

// Mark all notifications as read
router.put("/read-all", async (req, res) => {
    await Notification.updateMany(
      { recipient: req.user._id, isRead: false },
      { isRead: true, readAt: new Date() }
    );
    res.json({ success: true, message: "All notifications marked as read" });
});

// Mark a single notification as read
router.put("/:notificationId/read", async (req, res) => {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.notificationId, recipient: req.user._id },
      { isRead: true, readAt: new Date() },
      { new: true }
    );
    if (!notification) return res.status(404).json({ success: false, message: "Notification not found" });
    res.json({ success: true, data: notification });
});

// Delete a notification
router.delete("/:notificationId", async (req, res) => {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.notificationId,
      recipient: req.user._id,
    });
    if (!notification) return res.status(404).json({ success: false, message: "Notification not found" });
    res.json({ success: true, message: "Notification deleted" });
});

export default router;
