import { Router } from "express";
import SupportTicket from "../../models/SupportTicket.js";
import Notification from "../../models/Notification.js";
import { protect, authorize } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect, authorize("support", "admin"));

// Get support agent dashboard stats (queue, my tickets, priority breakdown)
router.get("/stats", async (req, res) => {
  const agentId = req.user._id;
  const [totalOpen, totalInProgress, myAssigned, myOpen, totalResolvedToday, totalTickets, priorityBreakdown] = await Promise.all([
    SupportTicket.countDocuments({ status: "open" }),
    SupportTicket.countDocuments({ status: "in_progress" }),
    SupportTicket.countDocuments({ assignedTo: agentId, status: { $in: ["open", "in_progress", "waiting_customer"] } }),
    SupportTicket.countDocuments({ assignedTo: agentId, status: "open" }),
    SupportTicket.countDocuments({ assignedTo: agentId, resolvedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
    SupportTicket.countDocuments(),
    SupportTicket.aggregate([{ $match: { status: { $in: ["open", "in_progress"] } } }, { $group: { _id: "$priority", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
  ]);
  res.json({ success: true, data: { queue: { open: totalOpen, inProgress: totalInProgress }, myTickets: { assigned: myAssigned, open: myOpen, resolvedToday: totalResolvedToday }, totalTickets, priorityBreakdown } });
});

// List all tickets with filters (status, priority, category, assigned agent)
router.get("/tickets", async (req, res) => {
  const { page = 1, limit = 20, status, priority, category, assignedTo } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (priority) filter.priority = priority;
  if (category) filter.category = category;
  if (assignedTo) filter.assignedTo = assignedTo;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Math.max(1, Number(limit)));

  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter).sort({ priority: -1, createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
      .populate("customer", "name email").populate("assignedTo", "name avatar").lean(),
    SupportTicket.countDocuments(filter),
  ]);
  res.json({ success: true, data: tickets, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Get ticket detail with threaded messages (marks customer messages as read)
router.get("/tickets/:ticketId", async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.ticketId)
    .populate("customer", "name email phone avatar").populate("messages.sender", "name avatar role")
    .populate("assignedTo", "name avatar").populate("order", "orderNumber status").populate("product", "name slug images");
  if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

  let hasUpdates = false;
  for (const msg of ticket.messages) {
    if (!msg.readAt && msg.senderRole === "customer" && msg.sender._id.toString() !== req.user._id.toString()) {
      msg.readAt = new Date();
      hasUpdates = true;
    }
  }
  if (hasUpdates) await ticket.save();

  res.json({ success: true, data: ticket });
});

// Assign ticket to self or another agent
router.put("/tickets/:ticketId/assign", async (req, res) => {
  const { agentId } = req.body;
  const ticket = await SupportTicket.findById(req.params.ticketId);
  if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

  const targetAgentId = agentId || req.user._id;
  ticket.assignedTo = targetAgentId;
  if (ticket.status === "open") ticket.status = "in_progress";
  ticket.statusHistory.push({ status: ticket.status, note: `Assigned to ${agentId ? "agent" : "self"}`, changedBy: req.user._id });
  await ticket.save();

  if (agentId && agentId !== req.user._id.toString()) {
    await Notification.create({ recipient: agentId, type: "support_reply", title: "Ticket Assigned", message: `Ticket ${ticket.ticketNumber} has been assigned to you`, data: { entityType: "ticket", entityId: ticket._id } });
  }
  res.json({ success: true, message: "Ticket assigned", data: ticket });
});

// Reply to a ticket (support agent)
router.post("/tickets/:ticketId/messages", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false, message: "Message is required" });

  const ticket = await SupportTicket.findById(req.params.ticketId);
  if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });
  if (["resolved", "closed"].includes(ticket.status)) return res.status(400).json({ success: false, message: `Cannot add messages to a ${ticket.status} ticket` });

  const attachments = (req.body.attachments || []).map((a) => ({ url: a.url, publicId: a.publicId }));
  ticket.messages.push({ sender: req.user._id, senderRole: req.user.role || "support", message, attachments });
  if (ticket.status === "waiting_customer") ticket.status = "in_progress";
  await ticket.save();

  await Notification.create({ recipient: ticket.customer, type: "support_reply", title: "Support Reply", message: `New reply on ticket ${ticket.ticketNumber}`, data: { entityType: "ticket", entityId: ticket._id } });
  res.status(201).json({ success: true, data: ticket });
});

// Update ticket status (open → in_progress → waiting_customer → resolved → closed)
router.put("/tickets/:ticketId/status", async (req, res) => {
  const { status, note = "", resolution = "" } = req.body;
  const validStatuses = ["open", "in_progress", "waiting_customer", "resolved", "closed"];
  if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: "Invalid status" });

  const ticket = await SupportTicket.findById(req.params.ticketId);
  if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

  ticket.status = status;
  if (resolution) ticket.resolution = resolution;
  if (status === "resolved") { ticket.resolvedAt = new Date(); ticket.resolution = resolution || note; }
  ticket.statusHistory.push({ status, note, changedBy: req.user._id });
  await ticket.save();

  await Notification.create({ recipient: ticket.customer, type: "support_reply", title: `Ticket ${status.replace(/_/g, " ")}`, message: `Your ticket ${ticket.ticketNumber} is now ${status.replace(/_/g, " ")}`, data: { entityType: "ticket", entityId: ticket._id } });
  res.json({ success: true, data: ticket });
});

// Update ticket priority (low/medium/high/urgent)
router.put("/tickets/:ticketId/priority", async (req, res) => {
  const { priority } = req.body;
  const validPriorities = ["low", "medium", "high", "urgent"];
  if (!validPriorities.includes(priority)) return res.status(400).json({ success: false, message: "Invalid priority" });

  const ticket = await SupportTicket.findById(req.params.ticketId);
  if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

  ticket.priority = priority;
  await ticket.save();
  res.json({ success: true, data: ticket });
});

export default router;
