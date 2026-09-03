import { Router } from "express";
import SupportTicket from "../../models/SupportTicket.js";
import Notification from "../../models/Notification.js";
import { generateTicketNumber } from "../../utils/helpers.js";
import { protect } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect);

// Create a support ticket with first message
router.post("/tickets", async (req, res) => {
    const { subject, category, priority, orderId, productId, message } = req.body;
    if (!subject || !category || !message) {
      return res.status(400).json({ success: false, message: "subject, category, and message are required" });
    }

    const validCategories = ["order_issue", "payment", "return", "refund", "product_query", "delivery", "account", "other"];
    if (!validCategories.includes(category)) return res.status(400).json({ success: false, message: "Invalid category" });

    const ticket = await SupportTicket.create({
      ticketNumber: generateTicketNumber(), subject, customer: req.user._id,
      order: orderId || null, product: productId || null, category, priority: priority || "medium",
      messages: [{ sender: req.user._id, senderRole: req.user.role || "customer", message }],
    });

    res.status(201).json({ success: true, message: "Ticket created", data: ticket });
});

// Get my tickets with pagination
router.get("/tickets", async (req, res) => {
    const { page = 1, limit = 20, status } = req.query;
    const filter = { customer: req.user._id };
    if (status) filter.status = status;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("assignedTo", "name avatar").lean(),
      SupportTicket.countDocuments(filter),
    ]);

    res.json({ success: true, data: tickets, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get ticket detail with threaded messages
router.get("/tickets/:ticketId", async (req, res) => {
    const ticket = await SupportTicket.findOne({ _id: req.params.ticketId, customer: req.user._id })
      .populate("messages.sender", "name avatar role").populate("assignedTo", "name avatar")
      .populate("order", "orderNumber status").populate("product", "name slug images");

    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

    // Mark unread messages from others as read
    for (const msg of ticket.messages) {
      if (!msg.readAt && msg.sender._id.toString() !== req.user._id.toString()) msg.readAt = new Date();
    }
    await ticket.save();

    res.json({ success: true, data: ticket });
});

// Reply to a ticket
router.post("/tickets/:ticketId/messages", async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: "Message is required" });

    const ticket = await SupportTicket.findOne({ _id: req.params.ticketId, customer: req.user._id });
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });
    if (["resolved", "closed"].includes(ticket.status)) {
      return res.status(400).json({ success: false, message: `Cannot add messages to a ${ticket.status} ticket` });
    }

    const attachments = (req.body.attachments || []).map((a) => ({ url: a.url, publicId: a.publicId }));

    ticket.messages.push({ sender: req.user._id, senderRole: req.user.role || "customer", message, attachments });
    if (ticket.status === "waiting_customer") ticket.status = "open";
    await ticket.save();

    if (ticket.assignedTo) {
      await Notification.create({ recipient: ticket.assignedTo, type: "support_reply", title: "New Message on Ticket", message: `Customer replied on ticket ${ticket.ticketNumber}`, data: { entityType: "ticket", entityId: ticket._id } });
    }

    res.status(201).json({ success: true, data: ticket });
});

export default router;
