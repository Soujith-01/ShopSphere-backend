import mongoose from "mongoose";

const variantSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // Variant combination (e.g., { "Size": "L", "Color": "Blue" })
    options: {
      type: Map,
      of: String,
      required: true,
    },

    // Display label (e.g., "L - Blue")
    label: { type: String, required: true },

    // SKU
    sku: { type: String, required: true, unique: true },

    // Pricing (can override parent product price)
    price: { type: Number, required: true, min: 0 },

    // Media (variant-specific images)
    images: [
      {
        url: { type: String, required: true },
        publicId: { type: String, required: true },
        alt: { type: String, default: "" },
      },
    ],

    // Inventory
    stock: { type: Number, default: 0, min: 0 },
    reservedStock: { type: Number, default: 0, min: 0 }, // Reserved in carts
    lowStockThreshold: { type: Number, default: 5 },

    // Weight override
    weight: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

variantSchema.index({ product: 1 });
variantSchema.index({ sku: 1 });
variantSchema.index({ product: 1, options: 1 });

// Virtual: available stock
variantSchema.virtual("availableStock").get(function () {
  return Math.max(0, this.stock - this.reservedStock);
});

variantSchema.set("toJSON", { virtuals: true });
variantSchema.set("toObject", { virtuals: true });

const Variant = mongoose.model("Variant", variantSchema);
export default Variant;
