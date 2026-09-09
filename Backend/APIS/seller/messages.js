import { Router } from "express";
import { body } from "express-validator";
import { protect } from "../../middlewares/authMiddleware.js";
import { requireSeller } from "../../middlewares/sellerMiddleware.js";
import { validate } from "../../middlewares/validateMiddleware.js";
import Conversation from "../../models/Conversation.js";
import Message from "../../models/Message.js";
import { sendMessage, pushMessage } from "../../services/messaging.js";

const router = Router();
router.use(protect, requireSeller);

// GET /api/seller/messages — conversations where this user is the seller
router.get("/", async (req, res) => {
  const conversations = await Conversation.find({ seller: req.user._id })
    .sort({ lastMessageAt: -1 })
    .populate("product", "name slug images")
    .populate("customer", "name")
    .lean();

  res.json({ success: true, data: conversations });
});

// GET /api/seller/messages/:id — messages in a conversation (marks read)
router.get("/:id", async (req, res) => {
  const conversation = await Conversation.findOne({ _id: req.params.id, seller: req.user._id });
  if (!conversation) {
    return res.status(404).json({ success: false, message: "Conversation not found" });
  }

  const messages = await Message.find({ conversation: conversation._id }).sort({ createdAt: 1 }).lean();

  if (conversation.unreadSeller > 0) {
    await Conversation.updateOne({ _id: conversation._id }, { $set: { unreadSeller: 0 } });
    await Message.updateMany(
      { conversation: conversation._id, sender: conversation.customer, read: false },
      { $set: { read: true, readAt: new Date() } }
    );
  }

  const populated = await Conversation.populate(conversation, [
    { path: "product", select: "name slug images" },
    { path: "customer", select: "name" },
  ]);

  res.json({ success: true, data: { conversation: populated, messages } });
});

// POST /api/seller/messages/:id — reply in a conversation (socket fallback)
router.post(
  "/:id",
  [body("text").trim().notEmpty().withMessage("Message text is required").isLength({ max: 2000 }).withMessage("Message must be at most 2000 characters")],
  validate,
  async (req, res) => {
    const conversation = await Conversation.findOne({ _id: req.params.id, seller: req.user._id });
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    const message = await sendMessage({ conversation, senderId: req.user._id, text: req.body.text });
    const io = req.app.get("io");
    const connectedUsers = req.app.get("connectedUsers");
    if (io) pushMessage({ io, connectedUsers, conversation, message, senderId: req.user._id });

    res.status(201).json({ success: true, data: message });
  }
);

export default router;