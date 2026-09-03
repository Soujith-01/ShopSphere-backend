import mongoose from "mongoose";

const sellerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    // Business info
    businessName: { type: String, required: true, trim: true },
    businessType: {
      type: String,
      enum: ["individual", "partnership", "private_ltd", "llp"],
      default: "individual",
    },

    // Verification
    isVerified: { type: Boolean, default: false },


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

sellerSchema.index({ user: 1 });
sellerSchema.index({ isVerified: 1 });

const Seller = mongoose.model("Seller", sellerSchema);
export default Seller;
