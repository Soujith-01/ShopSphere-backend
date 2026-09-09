import mongoose from "mongoose";

const sellerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
    },

    // Business info
    businessName: { type: String, required: true, trim: true },
    businessType: {
      type: String,
      enum: ["individual", "partnership", "private_ltd", "llp"],
      default: "individual",
    },

    // Verification / approval lifecycle. `status` is the source of truth;
    // `isVerified` is kept in sync (approved ⇔ true) for existing queries.
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    isVerified: { type: Boolean, default: false },
    rejectionReason: { type: String, default: null, maxlength: 500 },
    rejectedAt: { type: Date, default: null },


    // Seller stats (denormalized for fast reads)
    stats: {
      totalProducts: { type: Number, default: 0 },
      totalOrders: { type: Number, default: 0 },
      totalRevenue: { type: Number, default: 0 },
      avgRating: { type: Number, default: 0 },
      totalReviews: { type: Number, default: 0 },
    },

    // Platform commission rate (percentage)
    commissionRate: { type: Number, default: 10 },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// (user index is auto-created by unique: true)
sellerSchema.index({ isVerified: 1 });
sellerSchema.index({ status: 1 });

const Seller = mongoose.model("Seller", sellerSchema);
export default Seller;
