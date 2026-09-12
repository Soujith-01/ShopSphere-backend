import SupportTicket from "../models/SupportTicket.js";
import { postTicketMessage, canPostOnTicket } from "../services/ticketChat.js";

// Socket handlers for support-ticket chat. Relies on the connection-level
// "register" event (server.js) to know who is on the socket via socket.userId.
//
//   ticket:send  { ticketId, text }   → persists + broadcasts ticket:message
//
// REST endpoints remain the source of truth for history; sockets are the
// real-time layer so neither side needs to refresh.
export default function setupTicketSocket(io, connectedUsers) {
  io.on("connection", (socket) => {
    socket.on("ticket:send", async (payload, ack) => {
      try {
        const userId = socket.userId;
        const text = typeof payload?.text === "string" ? payload.text.trim() : "";

        if (!userId) {
          ack?.({ success: false, message: "Not registered — reconnect and register your session" });
          return;
        }
        if (!payload?.ticketId || !text) {
          ack?.({ success: false, message: "ticketId and text are required" });
          return;
        }

        const ticket = await SupportTicket.findById(payload.ticketId);
        if (!ticket) {
          ack?.({ success: false, message: "Ticket not found" });
          return;
        }
        if (["resolved", "closed"].includes(ticket.status)) {
          ack?.({ success: false, message: `Ticket is ${ticket.status} — reopen it to continue` });
          return;
        }
        if (!canPostOnTicket(ticket, userId)) {
          ack?.({ success: false, message: "You are not a participant in this ticket" });
          return;
        }

        const senderRole = String(ticket.customer) === userId ? "customer" : "support";
        const message = await postTicketMessage({
          io,
          connectedUsers,
          ticket,
          senderId: userId,
          senderRole,
          text,
        });

        ack?.({ success: true, data: { message } });
      } catch (err) {
        console.error(`[Socket] ticket:send failed: ${err.message}`);
        ack?.({ success: false, message: "Failed to send message" });
      }
    });
  });
}
