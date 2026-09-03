import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, default: "" },
    image: {
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
    },

    // For nested categories (optional parent)
    parentCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },

    // Attribute template for this category
    // e.g., Electronics → ["brand", "warranty", "screen_size"]
    //        Clothing → ["size", "color", "material"]
    attributes: [
      {
        name: { type: String, required: true },
        type: {
          type: String,
          enum: ["text", "number", "select", "multi-select", "boolean"],
          default: "text",
        },
        options: [{ type: String }], // For select/multi-select
        isRequired: { type: Boolean, default: false },
      },
    ],

    // Hierarchy level
    level: { type: Number, default: 0 }, // 0 = top-level, 1 = sub, 2 = sub-sub

    // Position for sorting
    sortOrder: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },
    isFeatured: { type: Boolean, default: false },
  },
  { timestamps: true }
);

categorySchema.index({ slug: 1 });
categorySchema.index({ parentCategory: 1 });
categorySchema.index({ level: 1 });
categorySchema.index({ sortOrder: 1 });

// Virtual: get children
categorySchema.virtual("children", {
  ref: "Category",
  localField: "_id",
  foreignField: "parentCategory",
});

categorySchema.set("toJSON", { virtuals: true });
categorySchema.set("toObject", { virtuals: true });

const Category = mongoose.model("Category", categorySchema);
export default Category;
