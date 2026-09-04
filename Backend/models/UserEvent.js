import mongoose from "mongoose";

const userEventSchema = new mongoose.Schema(
  {
    // Who performed the action — ALWAYS taken from the authenticated JWT, never the client body
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    eventType: {
      type: String,
      enum: ["VIEW", "CLICK", "SEARCH", "WISHLIST", "ADD_TO_CART", "PURCHASE"],
      required: true,
      uppercase: true,
    },
    // Extra context, e.g. { query: "...", quantity: 2, source: "search" }
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Fast lookups for recommendation building
userEventSchema.index({ userId: 1, createdAt: -1 });
userEventSchema.index({ productId: 1 });
userEventSchema.index({ eventType: 1 });

const UserEvent = mongoose.model("UserEvent", userEventSchema);
export default UserEvent;