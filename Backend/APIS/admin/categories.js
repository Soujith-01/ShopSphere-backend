import { Router } from "express";
import Category from "../../models/Category.js";
import { generateSlug } from "../../utils/helpers.js";

const router = Router();

// List all categories (optionally include inactive and filter by level)
router.get("/", async (req, res) => {
    const { level, includeInactive } = req.query;
    const filter = {};
    if (level !== undefined) filter.level = Number(level);
    if (includeInactive !== "true") filter.isActive = true;

    const categories = await Category.find(filter).sort({ sortOrder: 1, name: 1 }).populate("parentCategory", "name slug").lean();
    res.json({ success: true, data: categories });
});

// Create a category with hierarchy and attribute template
router.post("/", async (req, res) => {
    const { name, description, parentCategory, image, attributes, sortOrder, isFeatured } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "Name is required" });

    let slug = generateSlug(name);
    const existingSlug = await Category.findOne({ slug });
    if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;

    let level = 0;
    if (parentCategory) {
      const parent = await Category.findById(parentCategory);
      if (!parent) return res.status(404).json({ success: false, message: "Parent category not found" });
      level = parent.level + 1;
    }

    const category = await Category.create({ name, slug, description: description || "", parentCategory: parentCategory || null, image: image || {}, attributes: attributes || [], sortOrder: sortOrder || 0, level, isFeatured: isFeatured || false });
    res.status(201).json({ success: true, data: category });
});

// Update a category
router.put("/:categoryId", async (req, res) => {
    const category = await Category.findById(req.params.categoryId);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });

    const { name, description, parentCategory, image, attributes, sortOrder, isFeatured, isActive } = req.body;
    if (name) {
      category.name = name;
      let slug = generateSlug(name);
      const existingSlug = await Category.findOne({ slug, _id: { $ne: category._id } });
      if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;
      category.slug = slug;
    }
    if (description !== undefined) category.description = description;
    if (parentCategory !== undefined) category.parentCategory = parentCategory || null;
    if (image !== undefined) category.image = image;
    if (attributes !== undefined) category.attributes = attributes;
    if (sortOrder !== undefined) category.sortOrder = sortOrder;
    if (isFeatured !== undefined) category.isFeatured = isFeatured;
    if (isActive !== undefined) category.isActive = isActive;
    await category.save();

    res.json({ success: true, data: category });
});

// Delete a category (blocks if it has children)
router.delete("/:categoryId", async (req, res) => {
    const category = await Category.findById(req.params.categoryId);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });

    const children = await Category.countDocuments({ parentCategory: category._id });
    if (children > 0) return res.status(400).json({ success: false, message: "Cannot delete category with subcategories" });

    await category.deleteOne();
    res.json({ success: true, message: "Category deleted" });
});

export default router;
