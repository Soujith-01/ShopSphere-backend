import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    // Ownership
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

    // Basic info
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, default: "" },

    // AI-generated content
    aiDescription: { type: String, default: "" },
    aiSellingPoints: [{ type: String }],
    aiEmbedding: [{ type: Number }], // For semantic search

    // Pricing
    price: { type: Number, required: true, min: 0 },

    // Discount
    discount: {
      type: { type: String, enum: ["percentage", "flat"], default: null },
      value: { type: Number, default: 0 },
      validFrom: { type: Date, default: null },
      validTo: { type: Date, default: null },
    },

    // Media
    images: [
      {
        url: { type: String, required: true },
        publicId: { type: String, required: true },
        alt: { type: String, default: "" },
        sortOrder: { type: Number, default: 0 },
      },
    ],

    // Categories
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    subCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    tags: [{ type: String, trim: true }],

    // Custom attributes (based on category template)
    attributes: [
      {
        name: { type: String, required: true },
        value: { type: String, required: true },
      },
    ],

    // Variants (size, color, etc.)
    hasVariants: { type: Boolean, default: false },
    variantOptions: [
      {
        name: { type: String, required: true }, // e.g., "Size", "Color"
        values: [{ type: String }], // e.g., ["S","M","L"] or ["Red","Blue"]
      },
    ],

    // Shipping
    shipping: {
      weight: { type: Number, default: 0 }, // in grams
      dimensions: {
        length: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
      },
      freeShipping: { type: Boolean, default: false },
      shippingCost: { type: Number, default: 0 },
    },

    // Stats (denormalized)
    stats: {
      totalSold: { type: Number, default: 0 },
      totalRevenue: { type: Number, default: 0 },
      avgRating: { type: Number, default: 0 },
      totalReviews: { type: Number, default: 0 },
      totalViews: { type: Number, default: 0 },
      totalWishlisted: { type: Number, default: 0 },
    },

    // Status
    status: {
      type: String,
      enum: ["draft", "pending", "active", "inactive", "rejected"],
      default: "draft",
    },
    rejectionReason: { type: String, default: "" },
    publishedAt: { type: Date, default: null },
    isFeatured: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Indexes for search and filtering
productSchema.index({ name: "text", description: "text", tags: "text" });
productSchema.index({ slug: 1 });
productSchema.index({ seller: 1 });
productSchema.index({ store: 1 });
productSchema.index({ category: 1 });
productSchema.index({ status: 1 });
productSchema.index({ price: 1 });
productSchema.index({ "stats.avgRating": -1 });
productSchema.index({ "stats.totalSold": -1 });
productSchema.index({ createdAt: -1 });

const Product = mongoose.model("Product", productSchema);
export default Product;
