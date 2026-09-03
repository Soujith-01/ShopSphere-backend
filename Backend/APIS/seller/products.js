import { Router } from "express";
import Product from "../../models/Product.js";
import Variant from "../../models/Variant.js";
import { generateSlug } from "../../utils/helpers.js";

const router = Router();

// List all products belonging to this seller
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, status, search } = req.query;
    const filter = { seller: req.seller._id };
    if (status) filter.status = status;
    if (search) filter.$text = { $search: search };

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [products, total] = await Promise.all([
      Product.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("category", "name slug").populate("store", "name slug").lean(),
      Product.countDocuments(filter),
    ]);

    res.json({ success: true, data: products, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Create a new product (starts as draft)
router.post("/", async (req, res) => {
    const { name, description, price, category, subCategory, tags, attributes, images, shipping, hasVariants, variantOptions, discount, store } = req.body;
    if (!name || !price || !category) return res.status(400).json({ success: false, message: "name, price, and category are required" });

    let slug = generateSlug(name);
    const existingSlug = await Product.findOne({ slug });
    if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;

    const product = await Product.create({
      seller: req.seller._id, store: store || req.seller.store || undefined, name, slug,
      description: description || "", price: Number(price), category, subCategory: subCategory || null,
      tags: tags || [], attributes: attributes || [], images: images || [], shipping: shipping || {},
      hasVariants: hasVariants || false, variantOptions: variantOptions || [], discount: discount || {}, status: "draft",
    });

    res.status(201).json({ success: true, message: "Product created as draft", data: product });
});

// Submit product for admin review (draft → pending)
router.post("/:id/submit", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    if (!["draft", "rejected"].includes(product.status)) return res.status(400).json({ success: false, message: `Cannot submit in "${product.status}" status` });

    product.status = "pending";
    product.rejectionReason = "";
    await product.save();
    res.json({ success: true, message: "Product submitted for review", data: product });
});

// Get single product detail by ID with variants
router.get("/:id", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, seller: req.seller._id })
      .populate("category", "name slug attributes").populate("subCategory", "name slug").populate("store", "name slug");
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    const variants = await Variant.find({ product: product._id }).sort({ label: 1 }).lean();
    res.json({ success: true, data: { ...product.toObject(), variants } });
});

// Update a product
router.put("/:id", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    const disallowed = ["seller", "store", "status", "stats", "isFeatured"];
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) { if (!disallowed.includes(key)) updates[key] = value; }

    if (updates.name && updates.name !== product.name) {
      let slug = generateSlug(updates.name);
      const existingSlug = await Product.findOne({ slug, _id: { $ne: product._id } });
      if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;
      updates.slug = slug;
    }

    const updated = await Product.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json({ success: true, message: "Product updated", data: updated });
});

// Delete a product (hard delete if draft, soft delete otherwise)
router.delete("/:id", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    if (product.status === "draft") { await product.deleteOne(); }
    else { product.status = "inactive"; await product.save(); }

    res.json({ success: true, message: "Product deleted" });
});

// List all variants for a product
router.get("/:productId/variants", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.productId, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    const variants = await Variant.find({ product: product._id }).sort({ label: 1 }).lean();
    res.json({ success: true, data: variants });
});

// Create a variant for a product
router.post("/:productId/variants", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.productId, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    const { options, label, sku, price, images, stock, lowStockThreshold, weight } = req.body;
    if (!options || !label || !sku || price === undefined) return res.status(400).json({ success: false, message: "options, label, sku, and price are required" });

    const existingSku = await Variant.findOne({ sku });
    if (existingSku) return res.status(400).json({ success: false, message: `SKU "${sku}" already exists` });

    const variant = await Variant.create({
      product: product._id, options, label, sku, price: Number(price), images: images || [],
      stock: Number(stock) || 0, lowStockThreshold: Number(lowStockThreshold) || 5, weight: Number(weight) || 0,
    });

    if (!product.hasVariants) { product.hasVariants = true; await product.save(); }
    res.status(201).json({ success: true, data: variant });
});

// Update a variant
router.put("/:productId/variants/:variantId", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.productId, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    const variant = await Variant.findOne({ _id: req.params.variantId, product: product._id });
    if (!variant) return res.status(404).json({ success: false, message: "Variant not found" });

    if (req.body.sku && req.body.sku !== variant.sku) {
      const existingSku = await Variant.findOne({ sku: req.body.sku, _id: { $ne: variant._id } });
      if (existingSku) return res.status(400).json({ success: false, message: `SKU "${req.body.sku}" already exists` });
    }

    const disallowed = ["product"];
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) { if (!disallowed.includes(key)) updates[key] = value; }

    const updated = await Variant.findByIdAndUpdate(req.params.variantId, updates, { new: true, runValidators: true });
    res.json({ success: true, data: updated });
});

// Delete a variant (auto-disables hasVariants if last one deleted)
router.delete("/:productId/variants/:variantId", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.productId, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    const variant = await Variant.findOne({ _id: req.params.variantId, product: product._id });
    if (!variant) return res.status(404).json({ success: false, message: "Variant not found" });

    await variant.deleteOne();
    const remaining = await Variant.countDocuments({ product: product._id });
    if (remaining === 0) { product.hasVariants = false; await product.save(); }

    res.json({ success: true, message: "Variant deleted" });
});

// Update variant stock and low-stock threshold
router.put("/:productId/variants/:variantId/stock", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.productId, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    const variant = await Variant.findOne({ _id: req.params.variantId, product: product._id });
    if (!variant) return res.status(404).json({ success: false, message: "Variant not found" });

    const { stock, lowStockThreshold } = req.body;
    if (stock !== undefined) variant.stock = Math.max(0, Number(stock));
    if (lowStockThreshold !== undefined) variant.lowStockThreshold = Number(lowStockThreshold);
    await variant.save();

    res.json({ success: true, data: variant });
});

export default router;
