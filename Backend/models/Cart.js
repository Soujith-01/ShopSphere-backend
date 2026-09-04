import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema(
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
    // Snapshot at time of adding (price can change later)
    priceAtAdd: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },

    // Denormalized for quick cart rendering
    productName: { type: String, required: true },
    productImage: { type: String, default: "" },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    storeName: { type: String, default: "" },
  },
  { _id: true, timestamps: true }
);

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // One cart per user
    },

    items: [cartItemSchema],

    // Applied coupon (optional)
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },
    couponCode: { type: String, default: "" },
    discountAmount: { type: Number, default: 0 },

    // Totals (recalculated on each add/remove)
    subtotal: { type: Number, default: 0 },
    totalItems: { type: Number, default: 0 },

    // Cart expiry (abandoned cart cleanup)
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// (user index is auto-created by unique: true)
cartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Cart = mongoose.model("Cart", cartSchema);
export default Cart;
