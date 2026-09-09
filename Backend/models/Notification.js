import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    type: {
      type: String,
      enum: [
        "order_placed",
        "order_confirmed",
        "order_shipped",
        "order_delivered",
        "order_cancelled",
        "return_requested",
        "return_approved",
        "refund_processed",
        "new_review",
        "review_reply",
        "product_approved",
        "product_rejected",
        "seller_approved",
        "seller_rejected",
        "seller_pending_approval",
        "support_reply",
        "new_message",
        "coupon_available",
        "system",
      ],
      required: true,
    },

    title: { type: String, required: true },
    message: { type: String, required: true },

    // Deep link target
    data: {
      entityType: {
        type: String,
        enum: ["order", "product", "review", "ticket", "coupon", "seller", "conversation"],
      },
      entityId: { type: mongoose.Schema.Types.ObjectId },
    },

    isRead: { type: Boolean, default: false },
    readAt: { type: Date, default: null },

    // For real-time push via Socket.io
    isPushed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1 });

const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
