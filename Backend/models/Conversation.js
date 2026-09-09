import mongoose from "mongoose";

// A conversation between a customer and a seller about a specific product.
// `customer` and `seller` are User ids (not Seller profile ids) so socket
// delivery and JWT auth line up with the registered user.
const conversationSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // Denormalized preview of the last message (for the conversation list)
    lastMessage: {
      text: { type: String, default: "" },
      sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      at: { type: Date, default: null },
    },

    // Per-side unread counters so badges don't require scanning messages
    unreadCustomer: { type: Number, default: 0 },
    unreadSeller: { type: Number, default: 0 },

    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One active conversation per (customer, seller, product) trio.
conversationSchema.index({ customer: 1, seller: 1, product: 1 }, { unique: true });
conversationSchema.index({ customer: 1, lastMessageAt: -1 });
conversationSchema.index({ seller: 1, lastMessageAt: -1 });

const Conversation = mongoose.model("Conversation", conversationSchema);
export default Conversation;