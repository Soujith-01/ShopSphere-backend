import Conversation from "../models/Conversation.js";
import { sendMessage, pushMessage } from "../services/messaging.js";

// Registers socket handlers for the messaging feature. Relies on the
// connection-level "register" event (set in server.js) to know who is on the
// socket via socket.userId.
export default function setupMessageSocket(io, connectedUsers) {
  io.on("connection", (socket) => {
    socket.on("message:send", async (payload, ack) => {
      try {
        const userId = socket.userId;
        const text = typeof payload?.text === "string" ? payload.text.trim() : "";

        if (!userId) {
          ack?.({ success: false, message: "Not registered — reconnect and register your session" });
          return;
        }
        if (!payload?.conversationId || !text) {
          ack?.({ success: false, message: "conversationId and text are required" });
          return;
        }

        const conversation = await Conversation.findOne({ _id: payload.conversationId });
        if (!conversation) {
          ack?.({ success: false, message: "Conversation not found" });
          return;
        }

        const isMember =
          String(conversation.customer) === userId || String(conversation.seller) === userId;
        if (!isMember) {
          ack?.({ success: false, message: "You are not a participant in this conversation" });
          return;
        }

        const message = await sendMessage({ conversation, senderId: userId, text });
        await pushMessage({ io, connectedUsers, conversation, message, senderId: userId });

        ack?.({ success: true, data: { message } });
      } catch (err) {
        console.error(`[Socket] message:send failed: ${err.message}`);
        ack?.({ success: false, message: "Failed to send message" });
      }
    });
  });
}