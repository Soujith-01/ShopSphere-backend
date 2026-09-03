import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: "" },

    discountType: {
      type: String,
      enum: ["percentage", "flat"],
      required: true,
    },
    discountValue: { type: Number, required: true, min: 0 },

    // Limits
    maxDiscountAmount: { type: Number, default: null }, // Cap for percentage coupons
    minOrderAmount: { type: Number, default: 0 },
    maxUsageTotal: { type: Number, default: null }, // Total uses across platform
    maxUsagePerUser: { type: Number, default: 1 },

    // Current usage count
    usedCount: { type: Number, default: 0 },

    // Validity
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },

    // Scope: which sellers/products this applies to
    scope: {
      type: String,
      enum: ["platform", "seller", "category", "product"],
      default: "platform",
    },
    applicableSellers: [{ type: mongoose.Schema.Types.ObjectId, ref: "Seller" }],
    applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
    applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],

    // Who created it
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

couponSchema.index({ code: 1 });
couponSchema.index({ validFrom: 1, validTo: 1 });
couponSchema.index({ scope: 1 });

const Coupon = mongoose.model("Coupon", couponSchema);
export default Coupon;
