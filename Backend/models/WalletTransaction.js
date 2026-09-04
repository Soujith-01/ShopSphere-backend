import mongoose from "mongoose";

const walletTransactionSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },

    parentOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ParentOrder",
      default: null,
    },

    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },

    grossAmount: {
      type: Number,
      required: true,
    },

    platformFee: {
      type: Number,
      required: true,
    },

    sellerAmount: {
      type: Number,
      required: true,
    },

    transactionType: {
      type: String,
      enum: ["credit", "debit", "withdrawal", "refund"],
      required: true,
    },

    status: {
      type: String,
      enum: ["completed", "pending", "failed"],
      default: "completed",
    },

    description: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

walletTransactionSchema.index({ seller: 1, createdAt: -1 });
walletTransactionSchema.index({ parentOrder: 1 });

const WalletTransaction = mongoose.model(
  "WalletTransaction",
  walletTransactionSchema
);
export default WalletTransaction;
