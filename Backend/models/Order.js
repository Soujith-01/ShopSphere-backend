import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Variant",
      default: null,
    },
    productName: { type: String, required: true },
    productImage: { type: String, default: "" },

    // Price snapshot at time of order
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    discount: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },

    // Variant info snapshot
    variantLabel: { type: String, default: "" },
    sku: { type: String, default: "" },
  },
  { _id: true }
);

const orderSchema = new mongoose.Schema(
  {
    // Customer who placed the order
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Seller this sub-order belongs to (after splitting)
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    storeName: { type: String, default: "" },

    // Order number (human-readable, e.g., ORD-2024-00001)
    orderNumber: { type: String, required: true, unique: true },

    // Items in this sub-order
    items: [orderItemSchema],

    // Order state machine
    status: {
      type: String,
      enum: [
        "placed",
        "confirmed",
        "packed",
        "shipped",
        "out_for_delivery",
        "delivered",
        "cancelled",
        "return_requested",
        "return_approved",
        "return_shipped",
        "return_received",
        "refunded",
      ],
      default: "placed",
    },

    // Status history (audit trail)
    statusHistory: [
      {
        status: { type: String, required: true },
        note: { type: String, default: "" },
        changedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        timestamp: { type: Date, default: Date.now },
      },
    ],

    // Pricing
    subtotal: { type: Number, required: true },
    shippingCost: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },

    // Coupon applied at order level
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },

    // Payment
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
      refundId: { type: String, default: "" },
      refundedAt: { type: Date, default: null },
    },

    // Shipping address snapshot
    shippingAddress: {
      fullName: { type: String, required: true },
      phone: { type: String, required: true },
      street: { type: String, required: true },
    pincode: { type: String, required: true },
    },

    // Delivery partner
    deliveryPartner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    trackingNumber: { type: String, default: "" },
    estimatedDelivery: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },

    // Cancellation
    cancellationReason: { type: String, default: "" },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Seller settlement
    settlement: {
      sellerEarning: { type: Number, default: 0 },
      platformCommission: { type: Number, default: 0 },
      isSettled: { type: Boolean, default: false },
      settledAt: { type: Date, default: null },
    },

    // Customer notes
    customerNote: { type: String, default: "" },
    sellerNote: { type: String, default: "" },

    // Source: which parent order this was split from
    parentOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ParentOrder",
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ seller: 1, createdAt: -1 });
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ "payment.status": 1 });
orderSchema.index({ parentOrder: 1 });

const Order = mongoose.model("Order", orderSchema);
export default Order;
