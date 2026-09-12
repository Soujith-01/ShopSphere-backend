import SupportTicket from "../models/SupportTicket.js";
import Notification from "../models/Notification.js";

// Emit an event to every socket currently registered for a user.
const emitToUser = (io, connectedUsers, userId, event, payload) => {
  const sockets = connectedUsers.get(String(userId));
  if (!sockets) return;
  for (const sid of sockets) io.to(sid).emit(event, payload);
};

// Shape a ticket message for the wire (ids as strings, no mongoose internals).
const wireMessage = (ticket, msg) => ({
  _id: String(msg._id),
  ticketId: String(ticket._id),
  ticketNumber: ticket.ticketNumber,
  sender: String(msg.sender?._id || msg.sender),
  senderRole: msg.senderRole,
  senderName: msg.sender?.name || null,
  message: msg.message,
  createdAt: msg.createdAt,
});

// Notify the "other side" that a ticket they can see changed (new message /
// new ticket / status change). Agents watch their own queue live; the customer
// gets updates on their own tickets. Sends to specific users rather than
// broadcasting, so admins who aren't looking at support don't get pinged.
const notifyTicketWatchers = async ({ io, connectedUsers, ticket, exceptUserId }) => {
  const watchers = new Set();
  if (ticket.customer) watchers.add(String(ticket.customer._id || ticket.customer));
  if (ticket.assignedTo) watchers.add(String(ticket.assignedTo._id || ticket.assignedTo));
  watchers.delete(String(exceptUserId || ""));

  const payload = { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber };
  for (const uid of watchers) emitToUser(io, connectedUsers, uid, "ticket:updated", payload);
};

// Persist a message on a ticket, create the in-app notification for the other
// side, and push the new message + ticket:updated over sockets. Returns the
// saved message (with sender populated for the wire).
export const postTicketMessage = async ({ io, connectedUsers, ticket, senderId, senderRole, text }) => {
  ticket.messages.push({ sender: senderId, senderRole, message: text });
  if (senderRole === "customer" && ticket.status === "waiting_customer") ticket.status = "open";
  if (senderRole !== "customer" && ticket.status === "waiting_customer") ticket.status = "in_progress";
  await ticket.save();

  // Re-fetch so msg.sender is populated for the wire payload.
  await ticket.populate({ path: "messages.sender", select: "name avatar role" });
  const saved = ticket.messages[ticket.messages.length - 1];
  const wire = wireMessage(ticket, saved);

  // In-app notification for the other side (agent side handled per-role below).
  const recipientId =
    senderRole === "customer"
      ? ticket.assignedTo || null // unassigned tickets only ping the queue, not one agent
      : ticket.customer;
  if (recipientId) {
    try {
      await Notification.create({
        recipient: recipientId,
        sender: senderId,
        type: "support_reply",
        title: senderRole === "customer" ? `New Message on Ticket ${ticket.ticketNumber}` : `Support Reply on Ticket ${ticket.ticketNumber}`,
        message: text.length > 100 ? `${text.slice(0, 100)}…` : text,
        data: { entityType: "ticket", entityId: ticket._id },
      });
    } catch (err) {
      console.error(`[TicketChat] Notification creation failed: ${err.message}`);
    }
  }

  // Real-time: push to everyone watching (customer + assigned agent) and back
  // to the sender's other tabs for multi-tab sync.
  const userIds = new Set([
    String(ticket.customer?._id || ticket.customer),
    ...(ticket.assignedTo ? [String(ticket.assignedTo._id || ticket.assignedTo)] : []),
    String(senderId),
  ]);
  for (const uid of userIds) {
    emitToUser(io, connectedUsers, uid, "ticket:message", { ticketId: String(ticket._id), message: wire });
  }
  await notifyTicketWatchers({ io, connectedUsers, ticket, exceptUserId: senderId });

  return wire;
};

// Push a newly created ticket to the support queue (agents see it live).
export const announceNewTicket = async ({ io, connectedUsers, ticket }) => {
  await ticket.populate("customer", "name email");
  const summary = {
    ticketId: String(ticket._id),
    ticketNumber: ticket.ticketNumber,
    subject: ticket.subject,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    customer: { _id: String(ticket.customer?._id || ticket.customer), name: ticket.customer?.name || null },
  };

  // All support agents + admins get the new-ticket ping (they share the queue).
  const agents = await (await import("../models/User.js")).default
    .find({ role: { $in: ["support", "admin"] }, isActive: true })
    .select("_id");
  for (const agent of agents) {
    emitToUser(io, connectedUsers, agent._id, "ticket:new", summary);
    emitToUser(io, connectedUsers, agent._id, "ticket:updated", { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber });
  }
  return summary;
};

// Notify watchers of a status/priority change (no message payload).
export const announceTicketChange = async ({ io, connectedUsers, ticket }) => {
  await notifyTicketWatchers({ io, connectedUsers, ticket, exceptUserId: null });
};

// Socket-level guard: can this user post on this ticket?
export const canPostOnTicket = (ticket, userId) => {
  const uid = String(userId);
  return (
    String(ticket.customer) === uid ||
    (ticket.assignedTo && String(ticket.assignedTo) === uid) ||
    false
  );
};
