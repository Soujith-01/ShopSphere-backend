import { Router } from "express";
import Store from "../../models/Store.js";
import { generateSlug } from "../../utils/helpers.js";
import {
  createSellerSpreadsheet,
  shareSpreadsheetWithSeller,
  revokeSheetAccessExcept,
} from "../../services/googleSheetsServices.js";

const router = Router();

// A store needs its own sheet when it has none, when it still points at the
// platform's shared spreadsheet, or when another store uses the same one —
// otherwise two sellers would be reading and writing the same sheet.
async function needsPersonalSheet(store) {
  const spreadsheetId = store.googleSheet?.spreadsheetId;
  if (!spreadsheetId) return true;
  if (spreadsheetId === process.env.GOOGLE_SPREADSHEET_ID) return true;

  const otherStore = await Store.exists({
    _id: { $ne: store._id },
    "googleSheet.spreadsheetId": spreadsheetId,
  });

  return !!otherStore;
}

// Make sure this store owns a dedicated Google Sheet, shared with its seller.
// Best-effort: a Sheets failure (expired OAuth token, quota, ...) must never
// fail or roll back the store itself — it is retried on the next write/read.
async function ensureStoreSheet(store, sellerEmail) {
  // 1) No personal sheet yet → create it and hand it straight to the seller.
  if (await needsPersonalSheet(store)) {
    try {
      const googleSheet = await createSellerSpreadsheet(store.name, sellerEmail);
      if (googleSheet) {
        store.googleSheet = {
          spreadsheetId: googleSheet.spreadsheetId,
          spreadsheetUrl: googleSheet.spreadsheetUrl,
          sharedWith: googleSheet.sharedWith || "",
        };
        await store.save();
      }
    } catch (sheetErr) {
      console.error("⚠️ Google Sheets store creation failed:", sheetErr.message);
    }

    return store;
  }

  // 2) Sheet exists but wasn't shared (created before sharing existed, or the
  // share failed) → backfill it so the seller can open and edit their sheet.
  if (sellerEmail && store.googleSheet.sharedWith !== sellerEmail) {
    try {
      await shareSpreadsheetWithSeller(store.googleSheet.spreadsheetId, sellerEmail);
      store.googleSheet.sharedWith = sellerEmail;
      await store.save();
    } catch (shareErr) {
      const message = shareErr?.response?.data?.error?.message || shareErr.message;
      console.error("⚠️ Google Sheets share failed:", message);
    }
  }

  return store;
}

// Get seller's store details
router.get("/", async (req, res) => {
    const store = await Store.findOne({ seller: req.seller._id });
    if (!store) return res.status(404).json({ success: false, message: "Store not found. Please create one." });

    // Auto-heal missing seller.store reference
    if (!req.seller.store || String(req.seller.store) !== String(store._id)) {
      req.seller.store = store._id;
      await req.seller.save();
    }

    // Auto-heal missing googleSheet info (create + share with this seller)
    await ensureStoreSheet(store, req.user.email);

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
      seller: req.seller._id,
      name,
      slug,
      description: description || "",
      tagline: tagline || "",
      logo: logo || {},
      banner: banner || {},
      address: address || {},
      location: location || {},
      policies: policies || {},
      socialLinks: socialLinks || {},
    });

    // Create this seller's Google Sheet and share it with their email
    await ensureStoreSheet(store, req.user.email);

    req.seller.store = store._id;
    await req.seller.save();

    res.status(201).json({ success: true, message: "Store created", data: store });
});

// Update store details (name, logo, banner, address, policies, social links)
router.put("/", async (req, res) => {
    const store = await Store.findOne({ seller: req.seller._id });
    if (!store) return res.status(404).json({ success: false, message: "Store not found" });

    // googleSheet is server-owned: a seller must never be able to point their
    // store at someone else's spreadsheet (or drop their own sheet reference).
    const disallowed = ["seller", "ratings", "isFeatured", "googleSheet"];
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) { if (!disallowed.includes(key)) updates[key] = value; }

    if (updates.name && updates.name !== store.name) {
      let slug = generateSlug(updates.name);
      const existingSlug = await Store.findOne({ slug, _id: { $ne: store._id } });
      if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;
      updates.slug = slug;
    }

    const updated = await Store.findByIdAndUpdate(store._id, updates, { new: true, runValidators: true });

    // Auto-heal: a store whose sheet creation/share failed earlier (e.g. the
    // Google token was expired at creation time) gets fixed on the next save.
    await ensureStoreSheet(updated, req.user.email);

    res.json({ success: true, message: "Store updated", data: updated });
});

// Re-share this store's sheet with the seller's CURRENT email and revoke every
// other recipient. A seller whose account email changed (or whose sheet was
// never shared) can restore their own access from the dashboard with this.
router.post("/sheet/reshare", async (req, res) => {
    const store = await Store.findOne({ seller: req.seller._id });
    if (!store) return res.status(404).json({ success: false, message: "Store not found. Please create one." });

    const email = req.user.email;

    // No personal sheet yet (or still on the shared platform sheet) → provision
    // one, which shares it with this seller as part of creation.
    if (await needsPersonalSheet(store)) {
      const before = store.googleSheet?.spreadsheetId || "";
      await ensureStoreSheet(store, email);
      const after = store.googleSheet?.spreadsheetId || "";

      if (store.googleSheet?.sharedWith !== email) {
        return res.status(502).json({
          success: false,
          message: after && after !== before
            ? `Your new Google Sheet was created, but Google could not share it with ${email}. Please check that this address belongs to a Google account.`
            : "Could not create a Google Sheet for your store. Please try again in a moment.",
        });
      }

      return res.json({
        success: true,
        message: `Google Sheet created and shared with ${email}`,
        data: store,
      });
    }

    // 1) Grant access to the seller's current email.
    try {
      await shareSpreadsheetWithSeller(store.googleSheet.spreadsheetId, email);
    } catch (shareErr) {
      const reason = shareErr?.response?.data?.error?.message || shareErr.message;
      console.error("⚠️ Google Sheets re-share failed:", reason);
      return res.status(502).json({
        success: false,
        message: `Google could not share the sheet with ${email}: ${reason}`,
      });
    }

    // 2) Drop every other recipient, including the address this store was
    // shared with before the seller changed emails.
    const previousEmail = store.googleSheet.sharedWith;
    let revoked = [];
    try {
      revoked = await revokeSheetAccessExcept(store.googleSheet.spreadsheetId, email);
    } catch (revokeErr) {
      console.error("⚠️ Google Sheets access cleanup failed:", revokeErr.message);
    }

    store.googleSheet.sharedWith = email;
    await store.save();

    const removed = revoked.filter((entry) => entry && entry !== previousEmail);

    res.json({
      success: true,
      message: removed.length
        ? `Sheet shared with ${email} — access removed for ${removed.join(", ")}`
        : `Sheet shared with ${email}`,
      data: store,
    });
});

export default router;
