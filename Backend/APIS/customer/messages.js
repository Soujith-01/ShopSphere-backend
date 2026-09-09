import { Router } from "express";
import { body } from "express-validator";
import { protect } from "../../middlewares/authMiddleware.js";
import { validate } from "../../middlewares/validateMiddleware.js";
import Conversation from "../../models/Conversation.js";
import Message from "../../models/Message.js";
import {
  getProductSellerUserId,
  findOrCreateConversation,
  sendMessage,
  pushMessage,
} from "../../services/messaging.js";

const router = Router();
router.use(protect);

// GET /api/customer/messages — the customer's product conversations
router.get("/", async (req, res) => {
  const conversations = await Conversation.find({ customer: req.user._id })
    .sort({ lastMessageAt: -1 })
    .populate("product", "name slug images")
    .populate("seller", "name")
    .lean();

  res.json({ success: true, data: conversations });
});

// GET /api/customer/messages/:id — messages in a conversation (marks read)
router.get("/:id", async (req, res) => {
  const conversation = await Conversation.findOne({ _id: req.params.id, customer: req.user._id });
  if (!conversation) {
    return res.status(404).json({ success: false, message: "Conversation not found" });
  }

  const messages = await Message.find({ conversation: conversation._id }).sort({ createdAt: 1 }).lean();

  if (conversation.unreadCustomer > 0) {
    await Conversation.updateOne({ _id: conversation._id }, { $set: { unreadCustomer: 0 } });
    await Message.updateMany(
      { conversation: conversation._id, sender: conversation.seller, read: false },
      { $set: { read: true, readAt: new Date() } }
    );
  }

  const populated = await Conversation.populate(conversation, [
    { path: "product", select: "name slug images" },
    { path: "seller", select: "name" },
  ]);

  res.json({ success: true, data: { conversation: populated, messages } });
});

// POST /api/customer/messages — start a conversation with a product question
router.post(
  "/",
  [
    body("productId").isMongoId().withMessage("productId must be a valid ObjectId"),
    body("text").trim().notEmpty().withMessage("Message text is required").isLength({ max: 2000 }).withMessage("Message must be at most 2000 characters"),
  ],
  validate,
  async (req, res) => {
    const { productId, text } = req.body;

    const sellerUserId = await getProductSellerUserId(productId);
    if (!sellerUserId) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    if (sellerUserId === String(req.user._id)) {
      return res.status(400).json({ success: false, message: "You can't start a conversation with yourself" });
    }

    const { conversation, created } = await findOrCreateConversation({
      customerId: req.user._id,
      sellerUserId,
      productId,
    });

    const message = await sendMessage({ conversation, senderId: req.user._id, text });

    // Real-time push to the seller (and the customer's other tabs).
    const io = req.app.get("io");
    const connectedUsers = req.app.get("connectedUsers");
    if (io) pushMessage({ io, connectedUsers, conversation, message, senderId: req.user._id });

    res.status(201).json({ success: true, data: { conversation, message, created } });
  }
);

// POST /api/customer/messages/:id — send another message (socket fallback)
router.post(
  "/:id",
  [body("text").trim().notEmpty().withMessage("Message text is required").isLength({ max: 2000 }).withMessage("Message must be at most 2000 characters")],
  validate,
  async (req, res) => {
    const conversation = await Conversation.findOne({ _id: req.params.id, customer: req.user._id });
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