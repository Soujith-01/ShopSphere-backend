import { Router } from "express";
import Product from "../../models/Product.js";
import Variant from "../../models/Variant.js";
import Store from "../../models/Store.js";
import Notification from "../../models/Notification.js";
import { generateSlug } from "../../utils/helpers.js";
import { refreshProductEmbedding, shouldRefreshEmbedding } from "../../services/ai/embedding.js";
import { addProductToSheet } from "../../services/googleSheetsServices.js";
import {
  importProductsFromSheet,
  rememberSheetBaseline,
  syncProductToSheet,
} from "../../services/sheetSync.js";
import {
  MAX_IMAGES_PER_PRODUCT,
  discardImages,
  isCloudinaryConfigured,
  normalizeImages,
  publicIdsOf,
  uploadImageBuffer,
} from "../../services/cloudinaryService.js";
import { imageUploadErrors, uploadSingleImage } from "../../middlewares/imageUpload.js";


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

// Upload one product photo to Cloudinary and hand back its URL + public id.
//
// Sellers never type image URLs: the browser posts the file, the server owns the
// Cloudinary credentials, and the response is what the form stores in its image
// list. The seller identity comes from the auth middleware — any sellerId sent by
// the client is ignored.
router.post("/upload-image", uploadSingleImage, imageUploadErrors, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'No image file received — send one file in the "image" field',
    });
  }

  if (!isCloudinaryConfigured) {
    return res.status(503).json({
      success: false,
      message:
        "Image uploads are not configured yet — add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to Backend/.env",
    });
  }

  const uploaded = await uploadImageBuffer(req.file.buffer);

  res.status(201).json({
    success: true,
    data: { url: uploaded.url, publicId: uploaded.publicId },
  });
});

// Cleanup for photos that were uploaded but never saved to a product (the seller
// abandoned the form, or product creation failed) so they don't linger as
// orphans in Cloudinary. Only assets in this project's Cloudinary folder can be
// removed — see services/cloudinaryService.js.
router.post("/discard-images", async (req, res) => {
  const publicIds = Array.isArray(req.body?.publicIds)
    ? req.body.publicIds.slice(0, MAX_IMAGES_PER_PRODUCT)
    : [];

  const removed = await discardImages(publicIds);

  res.json({ success: true, data: { removed } });
});

// Create a new product — published immediately so customers can see it right away
router.post("/", async (req, res) => {
    const { name, description, price, stock, category, subCategory, tags, attributes, images, shipping, hasVariants, variantOptions, discount, store } = req.body;
    if (!name || price === undefined || price === null || price === "" || !category) {
      return res.status(400).json({ success: false, message: "name, price, and category are required" });
    }

    // Validate stock quantity
    const stockNum = Number(stock);
    if (stock === undefined || stock === null || stock === "" || isNaN(stockNum) || stockNum < 0 || !Number.isInteger(stockNum)) {
      return res.status(400).json({ success: false, message: "Stock quantity must be a non-negative whole number" });
    }

    // Products live under a store. A store id sent by the client must be THIS
    // seller's own store — otherwise a seller could publish into another
    // seller's store, and write rows into that store's Google Sheet.
    const ownStore = await Store.findOne({ seller: req.seller._id }).select("_id googleSheet").lean();
    if (!ownStore) return res.status(400).json({ success: false, message: "Create a store first before adding products" });

    if (store && String(store) !== String(ownStore._id)) {
      return res.status(403).json({ success: false, message: "You do not own that store" });
    }

    const storeId = ownStore._id;

    let slug = generateSlug(name);
    const existingSlug = await Product.findOne({ slug });
    if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;

    const product = await Product.create({
        seller: req.seller._id,
        store: storeId,
        name,
        slug,
        description: description || "",
        price: Number(price),
        stock: stockNum,
        category,
        subCategory: subCategory || null,
        tags: tags || [],
        attributes: attributes || [],
        // Cloudinary URLs/public ids from /upload-image, in display order
        images: normalizeImages(images, { altFallback: name }),
        shipping: shipping || {},
        hasVariants: hasVariants || false,
        variantOptions: variantOptions || [],
        discount: discount || {},
        status: "active",
        publishedAt: new Date(),
      });


// ===============================
// Sync product to this seller's own Google Sheets
// ===============================
try {
  const targetSpreadsheetId = ownStore.googleSheet?.spreadsheetId;

  if (!targetSpreadsheetId) throw new Error("no spreadsheet on this store yet");

  await addProductToSheet({
    productId: product._id.toString(),
    sellerId: product.seller.toString(),

    productName: product.name,
    description: product.description,

    price: product.price,
    stock: product.stock,

    discountType: product.discount?.type || "None",
    discountValue: product.discount?.value || 0,

    category: product.category?.toString() || "",

    tags: product.tags || [],

    imageUrls: (product.images || []).map(
      (image) => image.url
    ),

    weight: product.shipping?.weight || 0,
    shippingCost: product.shipping?.shippingCost || 0,
    freeShipping: product.shipping?.freeShipping || false,

    hasVariants: product.hasVariants || false,

    variants: product.variantOptions || [],

    status: product.status,

    createdAt: product.createdAt?.toISOString(),
    updatedAt: product.updatedAt?.toISOString(),
  }, targetSpreadsheetId);

  // The new row and MongoDB agree — remember that as the reconciliation
  // baseline so the next import doesn't read it back as a seller edit (Phase 8).
  await rememberSheetBaseline(product);

  console.log(
    `✅ Product ${product._id} synced to Google Sheets`
  );

} catch (sheetError) {

  // MongoDB product is already created.
  // Google Sheets failure should not delete/fail the product.
  console.error(
    "⚠️ Google Sheets sync failed:",
    sheetError.message
  );
}


// Generate the AI embedding for semantic search
// Fire-and-forget, never blocks/fails the request
refreshProductEmbedding(product._id);


res.status(201).json({
  success: true,
  message: "Product created successfully",
  data: product,
});
});

// Publish a draft or republish a rejected product — goes straight to active.
// Products are auto-published on create, so this only matters for products that
// were rejected by an admin and then fixed, or legacy drafts.
router.post("/:id/submit", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    if (!["draft", "rejected"].includes(product.status)) return res.status(400).json({ success: false, message: `Cannot submit in "${product.status}" status` });

    product.status = "active";
    product.rejectionReason = "";
    product.publishedAt = new Date();
    await product.save();

    // Notify this seller's notifications feed (recipient = Seller doc).
    await Notification.create({
      recipient: product.seller,
      type: "product_approved",
      title: "Product Approved",
      message: `Your product "${product.name}" is now live for customers.`,
      data: { entityType: "product", entityId: product._id },
    });

    res.json({
      success: true,
      message: "Product approved and now live for customers",
      data: product,
    });
});

// Import new products from Google Sheets (the same importer the 5-min
// background sync uses — see services/sheetSync.js)
router.post("/import-from-sheet", async (req, res) => {
  try {
    const store =
      (req.seller.store
        ? await Store.findById(req.seller.store).select("_id googleSheet").lean()
        : null) ||
      (await Store.findOne({ seller: req.seller._id }).select("_id googleSheet").lean());

    if (!store?._id) {
      return res.status(400).json({
        success: false,
        message: "Create a store first before importing products",
      });
    }

    const data = await importProductsFromSheet({ seller: req.seller, store });

    return res.json({
      success: true,
      message: "Google Sheets import completed",
      data,
    });
  } catch (error) {
    console.error("Google Sheets import failed:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to import products from Google Sheets",
      error: error.message,
    });
  }
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

    // sheetSync is server-owned bookkeeping (the sheet reconciliation baseline),
    // so a seller must not be able to rewrite it through the product API.
    const disallowed = ["seller", "store", "status", "stats", "isFeatured", "sheetSync"];
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) { if (!disallowed.includes(key)) updates[key] = value; }

    if (updates.name && updates.name !== product.name) {
      let slug = generateSlug(updates.name);
      const existingSlug = await Product.findOne({ slug, _id: { $ne: product._id } });
      if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;
      updates.slug = slug;
    }

    if (updates.stock !== undefined) {
      const stockNum = Number(updates.stock);
      if (isNaN(stockNum) || stockNum < 0 || !Number.isInteger(stockNum)) {
        return res.status(400).json({ success: false, message: "Stock quantity must be a non-negative whole number" });
      }
      updates.stock = stockNum;
    }

    // Photos sent by the form are the FINAL list (in display order): normalise
    // them so url/publicId/alt/sortOrder always match the Product model.
    if (updates.images !== undefined) {
      updates.images = normalizeImages(updates.images, {
        altFallback: String(updates.name || product.name || "").trim(),
      });
    }

  const updated = await Product.findByIdAndUpdate(
    req.params.id,
    updates,
    { new: true, runValidators: true }
  );

  if (!updated) {
    return res.status(404).json({
      success: false,
      message: "Product not found"
    });
  }


  // Photos removed or replaced in this edit: delete their Cloudinary assets, but
  // only now that the update is saved and validated. A failure here never fails
  // the request (a leftover asset is only wasted storage).
  const keptPublicIds = new Set(publicIdsOf(updated.images));
  const removedPublicIds = publicIdsOf(product.images).filter(
    (publicId) => !keptPublicIds.has(publicId)
  );
  if (removedPublicIds.length) await discardImages(removedPublicIds);

  // Sync the updated product (and its variant stock) to this seller's sheet —
  // this is also what pushes the new Cloudinary image URLs into `imageUrls`.
  // MongoDB is already updated — a Sheets failure never fails the request.
  await syncProductToSheet(updated);


  // Only regenerate the embedding when searchable fields actually changed
  if (shouldRefreshEmbedding(Object.keys(updates))) {
    refreshProductEmbedding(updated._id);
  }


  res.json({
    success: true,
    message: "Product updated",
    data: updated
  });
});

// Quick restock / update product stock directly
router.put("/:id/stock", async (req, res) => {
  const product = await Product.findOne({
    _id: req.params.id,
    seller: req.seller._id
  });

  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found"
    });
  }

  const { stock } = req.body;
  const stockNum = Number(stock);

  if (
    stock === undefined ||
    stock === null ||
    isNaN(stockNum) ||
    stockNum < 0 ||
    !Number.isInteger(stockNum)
  ) {
    return res.status(400).json({
      success: false,
      message: "Stock quantity must be a non-negative whole number"
    });
  }

  product.stock = stockNum;

  await product.save({ validateModifiedOnly: true });

  // Restock (or any stock change) → mirror it, and the variant stock, to the sheet
  await syncProductToSheet(product);

  res.json({
    success: true,
    message: "Stock updated successfully",
    data: product
  });
});

// Delete a product (hard delete if draft, soft delete otherwise)
router.delete("/:id", async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, seller: req.seller._id });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    if (product.status === "draft") {
      // A hard delete leaves no product to point at the photos — clean them up.
      await product.deleteOne();
      await discardImages(publicIdsOf(product.images));
    } else {
      // Soft delete: the seller may still restore the listing, so keep the photos.
      product.status = "inactive";
      await product.save();
    }

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

    // Keep the sheet's variants JSON (with per-variant stock) in step
    await syncProductToSheet(product);

    // Variant info is part of the embedding text — refresh
    refreshProductEmbedding(product._id);

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

    // Keep the sheet's variants JSON (with per-variant stock) in step
    await syncProductToSheet(product);

    refreshProductEmbedding(product._id);

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

    // Drop the removed variant from the sheet's variants JSON
    await syncProductToSheet(product);

    refreshProductEmbedding(product._id);

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

    // Variant-level restock → the sheet's variants JSON follows MongoDB
    await syncProductToSheet(product);

    res.json({ success: true, data: variant });
});

export default router;
