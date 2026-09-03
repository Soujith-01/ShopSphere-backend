import { Router } from "express";
import Category from "../../models/Category.js";

const router = Router();

// Get all top-level categories with nested children
router.get("/", async (req, res) => {
    const categories = await Category.find({ level: 0, isActive: true })
      .sort({ sortOrder: 1 })
      .populate("children")
      .lean();

    res.json({ success: true, data: categories });
});

// Get category by slug with children and attribute template
router.get("/:slug", async (req, res) => {
    const category = await Category.findOne({ slug: req.params.slug, isActive: true })
      .populate("children");

    if (!category) return res.status(404).json({ success: false, message: "Category not found" });

    res.json({ success: true, data: category });
});

export default router;
