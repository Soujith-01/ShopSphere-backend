import mongoose from "mongoose";

const returnRequestSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // Items being returned
    items: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        variant: { type: mongoose.Schema.Types.ObjectId, ref: "Variant" },
        productName: { type: String },
        quantity: { type: Number },
        reason: { type: String },
      },
    ],

    reason: {
      type: String,
      enum: [
        "defective",
        "wrong_item",
        "not_as_described",
        "damaged",
        "size_issue",
        "changed_mind",
        "other",
      ],
      required: true,
    },
    description: { type: String, default: "" },

    // Evidence
    images: [
      {
        url: { type: String, required: true },
        publicId: { type: String, required: true },
      },
    ],

    status: {
      type: String,
      enum: [
        "pending",
        "approved",
        "rejected",
        "return_shipped",
        "return_received",
        "refunded",
      ],
      default: "pending",
    },

    statusHistory: [
      {
        status: { type: String, required: true },
        note: { type: String, default: "" },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        timestamp: { type: Date, default: Date.now },
      },
    ],

    // Refund info
    refund: {
      amount: { type: Number, default: 0 },
      method: { type: String, default: "original" },
      transactionId: { type: String, default: "" },
      processedAt: { type: Date, default: null },
    },

    // Seller response
    sellerNote: { type: String, default: "" },
  },
  { timestamps: true }
);

returnRequestSchema.index({ order: 1 });
returnRequestSchema.index({ customer: 1, createdAt: -1 });
returnRequestSchema.index({ seller: 1 });
returnRequestSchema.index({ status: 1 });

const ReturnRequest = mongoose.model("ReturnRequest", returnRequestSchema);
export default ReturnRequest;
