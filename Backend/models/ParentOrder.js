import mongoose from "mongoose";

const parentOrderSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // The sub-orders created from this checkout
    subOrders: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
      },
    ],

    // Original cart items (for reference)
    originalItems: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        variant: { type: mongoose.Schema.Types.ObjectId, ref: "Variant" },
        seller: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
        store: { type: mongoose.Schema.Types.ObjectId, ref: "Store" },
        quantity: { type: Number },
        price: { type: Number },
      },
    ],

    // Total across all sub-orders
    total: { type: Number, required: true },
    totalItems: { type: Number, required: true },

    // Overall status derived from sub-orders
    status: {
      type: String,
      enum: [
        "processing",    // Sub-orders being created
        "partial",       // Some delivered, some in transit
        "completed",     // All sub-orders delivered
        "cancelled",     // All sub-orders cancelled
      ],
      default: "processing",
    },

    // Payment (single payment for entire checkout)
    payment: {
      method: {
        type: String,
        enum: ["cod", "upi", "card", "net_banking", "wallet"],
        default: "cod",
      },
      status: {
        type: String,
        enum: ["pending", "completed", "failed", "refunded"],
        default: "pending",
      },
      transactionId: { type: String, default: "" },
      paidAt: { type: Date, default: null },
    },

    // Coupon
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },
    discountAmount: { type: Number, default: 0 },

    // Shipping address used for all sub-orders
    shippingAddress: {
      fullName: { type: String, required: true },
      phone: { type: String, required: true },
      street: { type: String, required: true },
    },

    customerNote: { type: String, default: "" },
  },
  { timestamps: true }
);

parentOrderSchema.index({ customer: 1, createdAt: -1 });
parentOrderSchema.index({ status: 1 });

const ParentOrder = mongoose.model("ParentOrder", parentOrderSchema);
export default ParentOrder;
