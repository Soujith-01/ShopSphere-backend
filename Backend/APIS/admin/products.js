import { Router } from "express";
import Product from "../../models/Product.js";
import Notification from "../../models/Notification.js";
import AuditLog from "../../models/AuditLog.js";
import { refreshProductEmbedding } from "../../services/ai/embedding.js";

const router = Router();

// Get moderation queue (pending or rejected products)
router.get("/moderation", async (req, res) => {
    const { page = 1, limit = 20, status = "pending" } = req.query;
    const filter = { status };
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [products, total] = await Promise.all([
      Product.find(filter).sort({ createdAt: 1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("seller", "businessName").populate("store", "name").populate("category", "name").lean(),
      Product.countDocuments(filter),
    ]);
    res.json({ success: true, data: products, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// List all products (admin view with any status)
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, status, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) filter.$text = { $search: search };

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const [products, total] = await Promise.all([
      Product.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("seller", "businessName").populate("category", "name").lean(),
      Product.countDocuments(filter),
    ]);
    res.json({ success: true, data: products, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Approve a pending product (pending → active)
router.put("/:productId/approve", async (req, res) => {
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    if (product.status !== "pending") return res.status(400).json({ success: false, message: `Cannot approve in "${product.status}" status` });

    product.status = "active";
    product.publishedAt = new Date();
    product.rejectionReason = "";
    await product.save();

    // Approved products become searchable — make sure their embedding is fresh
    refreshProductEmbedding(product._id);

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "product.approved", entityType: "product", entityId: product._id, description: `Admin approved product "${product.name}"` });
    await Notification.create({ recipient: product.seller, type: "product_approved", title: "Product Approved", message: `Your product "${product.name}" has been approved and is now live.`, data: { entityType: "product", entityId: product._id } });
    res.json({ success: true, message: "Product approved", data: product });
});

// Reject a product with reason
router.put("/:productId/reject", async (req, res) => {
    const { reason = "" } = req.body;
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    product.status = "rejected";
    product.rejectionReason = reason;
    await product.save();

    await AuditLog.create({ actor: req.user._id, actorRole: "admin", action: "product.rejected", entityType: "product", entityId: product._id, description: `Admin rejected product "${product.name}": ${reason}` });
    await Notification.create({ recipient: product.seller, type: "product_rejected", title: "Product Rejected", message: `Your product "${product.name}" was rejected. Reason: ${reason}`, data: { entityType: "product", entityId: product._id } });
    res.json({ success: true, message: "Product rejected", data: product });
});

// Toggle product featured status
router.put("/:productId/featured", async (req, res) => {
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    product.isFeatured = !product.isFeatured;
    await product.save();
    res.json({ success: true, message: `Product ${product.isFeatured ? "featured" : "unfeatured"}`, data: { isFeatured: product.isFeatured } });
});

export default router;
