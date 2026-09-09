import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Notification from "../models/Notification.js";
import Product from "../models/Product.js";

// Emit an event to every socket currently registered for a user.
const emitToUser = (io, connectedUsers, userId, event, payload) => {
  const sockets = connectedUsers.get(String(userId));
  if (!sockets) return;
  for (const sid of sockets) io.to(sid).emit(event, payload);
};

// The seller's USER id for a product (Product.seller → Seller.user).
export const getProductSellerUserId = async (productId) => {
  const product = await Product.findById(productId).populate("seller", "user").lean();
  return product?.seller?.user ? String(product.seller.user) : null;
};

// Reuse an existing conversation or create a new one for (customer, seller, product).
export const findOrCreateConversation = async ({ customerId, sellerUserId, productId }) => {
  let conversation = await Conversation.findOne({
    customer: customerId,
    seller: sellerUserId,
    product: productId,
  });
  if (conversation) return { conversation, created: false };

  conversation = await Conversation.create({
    customer: customerId,
    seller: sellerUserId,
    product: productId,
  });
  return { conversation, created: true };
};

// Persist a message, refresh the conversation preview, and bump the
// recipient's unread counter. Returns the saved message.
export const sendMessage = async ({ conversation, senderId, text }) => {
  const senderSide = String(conversation.customer) === String(senderId) ? "customer" : "seller";
  const message = await Message.create({
    conversation: conversation._id,
    sender: senderId,
    text,
  });

  const unreadField = senderSide === "customer" ? "unreadSeller" : "unreadCustomer";
  await Conversation.findByIdAndUpdate(conversation._id, {
    lastMessage: { text, sender: senderId, at: message.createdAt },
    lastMessageAt: message.createdAt,
    $inc: { [unreadField]: 1 },
  });

  return message;
};

// Real-time delivery: push the new message to the recipient's sockets (and the
// sender's other sockets for multi-tab sync) + create a notification for the
// recipient. Returns the recipient's user id.
export const pushMessage = async ({ io, connectedUsers, conversation, message, senderId }) => {
  const senderIdStr = String(senderId);
  const otherId =
    String(conversation.customer) === senderIdStr
      ? String(conversation.seller)
      : String(conversation.customer);

  const payload = {
    conversationId: String(conversation._id),
    message: {
      _id: String(message._id),
      conversation: String(conversation._id),
      sender: senderIdStr,
      text: message.text,
      createdAt: message.createdAt,
    },
  };

  emitToUser(io, connectedUsers, otherId, "message:new", payload);
  emitToUser(io, connectedUsers, senderIdStr, "message:new", payload);

  try {
    await Notification.create({
      recipient: otherId,
      sender: senderId,
      type: "new_message",
      title: "New message",
      message: message.text.length > 100 ? `${message.text.slice(0, 100)}…` : message.text,
      data: { entityType: "conversation", entityId: conversation._id },
    });
  } catch (err) {
    console.error(`[Messaging] Notification creation failed: ${err.message}`);
  }

  return otherId;
};