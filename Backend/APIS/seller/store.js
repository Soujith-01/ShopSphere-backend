import { Router } from "express";
import Store from "../../models/Store.js";
import { generateSlug } from "../../utils/helpers.js";

const router = Router();

// Get seller's store details
router.get("/", async (req, res) => {
    const store = await Store.findOne({ seller: req.seller._id });
    if (!store) return res.status(404).json({ success: false, message: "Store not found. Please create one." });
    res.json({ success: true, data: store });
});

// Create a new store for this seller
router.post("/", async (req, res) => {
    const existing = await Store.findOne({ seller: req.seller._id });
    if (existing) return res.status(400).json({ success: false, message: "Store already exists. Use PUT to update." });

    const { name, description, tagline, logo, banner, address, location, policies, socialLinks } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "Store name is required" });

    let slug = generateSlug(name);
    const existingSlug = await Store.findOne({ slug });
    if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;

    const store = await Store.create({
      seller: req.seller._id, name, slug, description: description || "", tagline: tagline || "",
      logo: logo || {}, banner: banner || {}, address: address || {}, location: location || {},
      policies: policies || {}, socialLinks: socialLinks || {},
    });

    req.seller.store = store._id;
    await req.seller.save();

    res.status(201).json({ success: true, message: "Store created", data: store });
});

// Update store details (name, logo, banner, address, policies, social links)
router.put("/", async (req, res) => {
    const store = await Store.findOne({ seller: req.seller._id });
    if (!store) return res.status(404).json({ success: false, message: "Store not found" });

    const disallowed = ["seller", "ratings", "isFeatured"];
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) { if (!disallowed.includes(key)) updates[key] = value; }

    if (updates.name && updates.name !== store.name) {
      let slug = generateSlug(updates.name);
      const existingSlug = await Store.findOne({ slug, _id: { $ne: store._id } });
      if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;
      updates.slug = slug;
    }

    const updated = await Store.findByIdAndUpdate(store._id, updates, { new: true, runValidators: true });
    res.json({ success: true, message: "Store updated", data: updated });
});

export default router;
