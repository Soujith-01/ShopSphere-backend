import mongoose from "mongoose";

const storeSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
      unique: true,
    },

    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, default: "" },
    tagline: { type: String, default: "" },

    logo: {
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
    },
    banner: {
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
    },

    // Store location (for local delivery logic)
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: [0, 0] },
    },
    address: {
      street: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" },
    },

    // Store policies
    policies: {
      shippingPolicy: { type: String, default: "" },
      returnPolicy: { type: String, default: "" },
      privacyPolicy: { type: String, default: "" },
    },

    // Social links
    socialLinks: {
      website: { type: String, default: "" },
      instagram: { type: String, default: "" },
      facebook: { type: String, default: "" },
      twitter: { type: String, default: "" },
    },

    // Store ratings (denormalized)
    ratings: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },


    isActive: { type: Boolean, default: true },
    isFeatured: { type: Boolean, default: false },
  },
  { timestamps: true }
);

storeSchema.index({ slug: 1 });
storeSchema.index({ seller: 1 });
storeSchema.index({ "location": "2dsphere" });
storeSchema.index({ isFeatured: 1 });

const Store = mongoose.model("Store", storeSchema);
export default Store;
