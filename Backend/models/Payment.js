import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    transactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Reference to the parent order (populated after order finalization)
    parentOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ParentOrder",
      default: null,
    },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      default: "INR",
      enum: ["INR"],
    },

    paymentProvider: {
      type: String,
      default: "razorpay",
    },

    paymentMethod: {
      type: String,
      default: "razorpay",
    },

    razorpayOrderId: {
      type: String,
      default: "",
    },

    razorpayPaymentId: {
      type: String,
      default: "",
    },

    razorpaySignature: {
      type: String,
      default: "",
    },

    status: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED", "CANCELLED"],
      default: "PENDING",
    },

    // Failure reason (for failed payments)
    failureReason: { type: String, default: "" },
  },
  { timestamps: true }
);

paymentSchema.index({ customer: 1, createdAt: -1 });
paymentSchema.index({ parentOrder: 1 });

const Payment = mongoose.model("Payment", paymentSchema);
export default Payment;
