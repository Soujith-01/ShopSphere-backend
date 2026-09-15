/**
 * Google Sheet → MongoDB product sync.
 *
 * Every store owns its own spreadsheet, so a row dropped into a seller's sheet
 * belongs to that seller — they never have to type their seller id. The importer
 * below is shared by the manual "import from sheet" endpoint and by the
 * background scheduler, so both paths behave identically.
 */
import mongoose from "mongoose";
import Store from "../models/Store.js";
import Seller from "../models/Seller.js";
import Product from "../models/Product.js";
import Variant from "../models/Variant.js";
import Category from "../models/Category.js";
import { generateSlug } from "../utils/helpers.js";
import { generateProductDescription } from "./ai/description.js";
import {
  getProductsFromSheet,
  updateProductIdInSheet,
  updateSellerIdInSheet,
  updateProductDescriptionInSheet,
  updateProductInSheet,
} from "./googleSheetsServices.js";
import { readSheetNumber, resolveFieldConflicts } from "./sheetConflicts.js";
import { discardImages, publicIdsOf } from "./cloudinaryService.js";
import { syncInventoryToSheet } from "./sheetInventory.js";

const VALID_STATUSES = ["draft", "pending", "active", "inactive", "rejected"];

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// A variant's `options` is a Mongoose Map on documents but a plain object after
// `.lean()` — Object.fromEntries() only accepts a Map/iterable, so normalise it.
const optionsToObject = (options) => {
  if (!options) return {};
  if (options instanceof Map) return Object.fromEntries(options);
  return { ...options };
};

const parseBool = (value) =>
  value === "true" || value === "TRUE" || value === "1";

/**
 * Record the stock/price the sheet has just been reconciled to, so the importer
 * can tell a deliberate seller edit apart from a row MongoDB has moved past
 * (Phase 8 — see services/sheetConflicts.js).
 *
 * Bookkeeping only: `timestamps: false` keeps `updatedAt` (and therefore the
 * sheet's updatedAt column) untouched.
 *
 * @param {object} product Product doc or lean object ({ _id, stock, price })
 * @param {object[]|null} variants the lean variants already loaded by the caller
 */
export async function rememberSheetBaseline(product, variants = null) {
  const rows =
    variants || (await Variant.find({ product: product._id }).select("stock price").lean());

  const variantBaselines = {};
  for (const variant of rows) {
    variantBaselines[String(variant._id)] = { stock: variant.stock, price: variant.price };
  }

  await Product.updateOne(
    { _id: product._id },
    {
      $set: {
        "sheetSync.stock": product.stock,
        "sheetSync.price": product.price,
        "sheetSync.variants": variantBaselines,
        "sheetSync.syncedAt": new Date(),
      },
    },
    { timestamps: false }
  );
}

/**
 * Push a product's current stock/pricing to the Google Sheet of the store that
 * owns it — including every variant with its own stock, so the `variants` column
 * always mirrors MongoDB (orders, cancellations, restocks, variant edits).
 *
 * Best-effort by design: it runs inside order flows, so a Sheets failure is
 * logged and swallowed rather than failing the customer's checkout.
 *
 * @returns {Promise<string|null>} the spreadsheet id it wrote to, or null.
 */
export async function syncProductToSheet(productOrId) {
  try {
    const product = mongoose.isValidObjectId(productOrId)
      ? await Product.findById(productOrId)
      : productOrId;

    if (!product) return null;

    const store = await Store.findById(product.store).select("googleSheet").lean();
    const spreadsheetId = store?.googleSheet?.spreadsheetId;

    // No personal sheet yet — nothing to mirror into (the 5-min job will not
    // fix this either, since stock lives in rows that already exist).
    if (!spreadsheetId) return null;

    const variants = await Variant.find({ product: product._id }).lean();

    await updateProductInSheet(
      {
        ...product.toObject(),
        variants: variants.map((variant) => ({
          id: variant._id.toString(),
          label: variant.label,
          sku: variant.sku,
          options: optionsToObject(variant.options),
          price: variant.price,
          stock: variant.stock,
          reservedStock: variant.reservedStock,
          lowStockThreshold: variant.lowStockThreshold,
          weight: variant.weight,
          isActive: variant.isActive,
        })),
      },
      spreadsheetId
    );

    // The sheet now shows these numbers — remember them as the reconciliation
    // baseline so the next import doesn't mistake this write for a seller edit.
    await rememberSheetBaseline(product, variants);

    console.log(`✅ [SheetSync] Stock synced for product ${product._id}`);

    return spreadsheetId;
  } catch (error) {
    const message = error?.response?.data?.error?.message || error.message;
    console.error(`⚠️ [SheetSync] Stock sync failed for product ${productOrId}:`, message);
    return null;
  }
}

// The category column may hold a Category ObjectId (rows written by the app) or
// a plain name the seller typed (slugs are generated from names), so accept both.
async function resolveCategoryId(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  if (mongoose.isValidObjectId(value)) {
    const byId = await Category.findById(value).select("_id").lean();
    if (byId) return byId._id;
  }

  const bySlug = await Category.findOne({ slug: generateSlug(value) }).select("_id").lean();
  return bySlug?._id || null;
}

/**
 * Apply the seller's Google Sheet edits to a product that already exists in
 * MongoDB — the reverse direction (sheet → app). Only fields that actually
 * differ are written, so an unchanged row never bumps `updatedAt`.
 *
 * The sheet is the source of truth for the columns a purchase cannot move
 * (name, description, category, images, …). Stock and price are the exception:
 * they are resolved by the Phase 8 conflict rule, so a sheet edit wins when the
 * seller made it, but a live purchase is never overridden by a stale row.
 *
 * @returns {Promise<{changedFields: string[], variantChanges: object[], stale: object[], conflicts: object[]}>}
 *   `stale` lists stock/price cells MongoDB owns and the caller must rewrite.
 */
async function applySheetEdits(product, row) {
  const changes = {};

  // Name (and slug, matching the rename behaviour of the product routes)
  const name = String(row.productName ?? "").trim();
  if (name && name !== product.name) {
    let slug = generateSlug(name);
    const taken = await Product.findOne({ slug, _id: { $ne: product._id } }).select("_id").lean();
    if (taken) slug = `${slug}-${Date.now().toString(36)}`;
    changes.name = name;
    changes.slug = slug;
  }

  const description = String(row.description ?? "");
  if (description !== (product.description || "")) changes.description = description;

  // Stock and price are the two columns a purchase also moves, so they go
  // through the conflict rule instead of plain "sheet wins".
  const sheetStock = readSheetNumber(row.stock);
  const sheetPrice = readSheetNumber(row.price);

  const numeric = resolveFieldConflicts([
    {
      field: "stock",
      sheet: Number.isInteger(sheetStock) && sheetStock >= 0 ? sheetStock : null,
      mongo: product.stock,
      baseline: product.sheetSync?.stock,
    },
    {
      field: "price",
      sheet: sheetPrice !== null && sheetPrice >= 0 ? sheetPrice : null,
      mongo: product.price,
      baseline: product.sheetSync?.price,
    },
  ]);

  Object.assign(changes, numeric.changes);

  const categoryId = await resolveCategoryId(row.category);
  if (categoryId && String(categoryId) !== String(product.category)) changes.category = categoryId;

  const tags = row.tags ? row.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  if (tags.join("|") !== (product.tags || []).join("|")) changes.tags = tags;

  // Images: the sheet only carries URLs, so re-use the publicId we already have
  // for a URL instead of dropping it.
  const imageUrls = row.imageUrls ? row.imageUrls.split(",").map((url) => url.trim()).filter(Boolean) : [];
  let droppedImageIds = [];

  if (imageUrls.join("|") !== (product.images || []).map((image) => image.url).join("|")) {
    changes.images = imageUrls.map((url, index) => {
      const known = (product.images || []).find((image) => image.url === url);
      return {
        url,
        publicId: known?.publicId || "",
        alt: name || product.name,
        sortOrder: index,
      };
    });

    // A photo URL deleted from the sheet drops that Cloudinary asset too, once
    // the change is saved — otherwise the sheet could orphan a photo forever.
    const keptImageIds = new Set(changes.images.map((image) => image.publicId).filter(Boolean));
    droppedImageIds = publicIdsOf(product.images).filter((publicId) => !keptImageIds.has(publicId));
  }

  // Status can be driven from the sheet (e.g. "inactive" to pull a product),
  // but a sheet must never resurrect something an admin rejected — sellers use
  // POST /products/:id/submit for that.
  const status = VALID_STATUSES.includes(String(row.status || "").toLowerCase())
    ? String(row.status).toLowerCase()
    : null;
  if (status && status !== product.status && product.status !== "rejected") {
    changes.status = status;
  }

  const discountType = row.discountType && row.discountType !== "None" ? row.discountType : null;
  const discountValue = Number(row.discountValue || 0);
  if ((product.discount?.type || null) !== discountType) changes["discount.type"] = discountType;
  if ((product.discount?.value ?? 0) !== discountValue) changes["discount.value"] = discountValue;

  const weight = Number(row.weight || 0);
  const shippingCost = Number(row.shippingCost || 0);
  const freeShipping = parseBool(row.freeShipping);
  if ((product.shipping?.weight || 0) !== weight) changes["shipping.weight"] = weight;
  if ((product.shipping?.shippingCost || 0) !== shippingCost) changes["shipping.shippingCost"] = shippingCost;
  if (Boolean(product.shipping?.freeShipping) !== freeShipping) changes["shipping.freeShipping"] = freeShipping;

  const changedFields = Object.keys(changes);
  if (changedFields.length) {
    product.set(changes);
    await product.save();
  }

  // Photos removed from the sheet: delete their Cloudinary assets now that the
  // product update is saved. Best-effort — a leftover asset is only storage.
  if (droppedImageIds.length) await discardImages(droppedImageIds);

  // Variants JSON edited in the sheet → per-variant stock/price in MongoDB.
  const variantEdits = await applyVariantEdits(product, row);

  return {
    changedFields,
    variantChanges: variantEdits.changes,
    // Cells MongoDB owns (a purchase moved them) — the caller rewrites the row.
    stale: [...numeric.stale, ...variantEdits.stale],
    conflicts: [...numeric.conflicts, ...variantEdits.conflicts],
  };
}

// Apply the `variants` JSON column back onto the variant documents, matching by
// id first, then sku, then label so a hand-edited row still lines up.
//
// Per-variant stock/price go through the same Phase 8 conflict rule as the
// product row: a purchase decrements variant stock in MongoDB, so a sheet value
// that is merely older than the last reconciliation must not win.
async function applyVariantEdits(product, row) {
  const result = { changes: [], stale: [], conflicts: [] };
  if (!row.variants) return result;

  let parsed;
  try {
    parsed = JSON.parse(row.variants);
  } catch {
    return result;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return result;

  const variants = await Variant.find({ product: product._id });
  const baselines = product.sheetSync?.variants;

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;

    const match = variants.find(
      (variant) =>
        (entry.id && String(variant._id) === String(entry.id)) ||
        (entry.sku && variant.sku === entry.sku) ||
        (entry.label && variant.label === entry.label)
    );
    if (!match) continue;

    // Mongoose stores this as a Map; tolerate a plain object too.
    const baseline = baselines?.get?.(String(match._id)) ?? baselines?.[String(match._id)] ?? null;

    const sheetStock = readSheetNumber(entry.stock);
    const sheetPrice = readSheetNumber(entry.price);

    const decided = resolveFieldConflicts([
      {
        field: "stock",
        sheet: Number.isInteger(sheetStock) && sheetStock >= 0 ? sheetStock : null,
        mongo: match.stock,
        baseline: baseline?.stock ?? null,
      },
      {
        field: "price",
        sheet: sheetPrice !== null && sheetPrice >= 0 ? sheetPrice : null,
        mongo: match.price,
        baseline: baseline?.price ?? null,
      },
    ]);

    if (Object.keys(decided.changes).length) {
      await Variant.updateOne({ _id: match._id }, { $set: decided.changes });
      result.changes.push({ label: match.label, ...decided.changes });
    }

    for (const entryStale of decided.stale) {
      result.stale.push({ ...entryStale, variant: match.label });
    }
    for (const entryConflict of decided.conflicts) {
      result.conflicts.push({ ...entryConflict, variant: match.label });
    }
  }

  return result;
}

/**
 * Import one store's sheet into the app: creates rows that have no product yet
 * and applies edits for rows that already do.
 *
 * Stock/price are resolved with the Phase 8 conflict rule, so `conflicts` lists
 * the rows where a purchase beat a stale sheet edit (and the sheet was corrected).
 * @returns {Promise<{imported: object[], updated: object[], skipped: object[], errors: object[], conflicts: object[]}>}
 */
export async function importProductsFromSheet({ seller, store }) {
  const spreadsheetId = store?.googleSheet?.spreadsheetId;
  const empty = { imported: [], updated: [], skipped: [], errors: [], conflicts: [] };
  if (!spreadsheetId) return empty;

  const sellerId = seller._id.toString();
  const storeId = store._id;

  const rows = await getProductsFromSheet(spreadsheetId);

  const imported = [];
  const updated = [];
  const skipped = [];
  const errors = [];
  const conflicts = [];

  for (const row of rows) {
    try {
      // Rows written by the app carry the seller id; rows typed straight into
      // the sheet leave it blank. Both belong to this seller (it's their sheet),
      // so only an explicit mismatch is skipped.
      if (row.sellerId && row.sellerId !== sellerId) continue;

      // Stamp the seller id so the column fills itself in for next time.
      if (!row.sellerId) {
        await updateSellerIdInSheet(row.sheetRow, sellerId, spreadsheetId);
      }

      // Row already tied to a product → the sheet is the source of truth for the
      // columns it carries, so price/stock/description edits come back in here.
      if (row.productId) {
        const existingProduct = await Product.findById(row.productId);

        if (existingProduct) {
          // A sheet must never be able to edit another seller's product.
          if (
            String(existingProduct.seller) !== sellerId ||
            String(existingProduct.store) !== String(storeId)
          ) {
            skipped.push({
              row: row.sheetRow,
              productId: row.productId,
              reason: "Product belongs to another seller",
            });
            continue;
          }

          const edits = await applySheetEdits(existingProduct, row);

          // Phase 8 — MongoDB owns stock/price whenever a purchase, cancel or
          // restock moved it. Rewriting the row from MongoDB is what stops a
          // stale sheet number from being sold a second time (and it self-heals
          // a stock mirror whose Sheets write failed earlier).
          if (edits.stale.length) {
            // Also refreshes the reconciliation baseline.
            await syncProductToSheet(existingProduct);
          } else if (edits.changedFields.length || edits.variantChanges.length) {
            // The seller's edits were applied, so they are the new baseline —
            // otherwise the next cycle would read them back as a conflict.
            await rememberSheetBaseline(existingProduct);
          }

          if (edits.conflicts.length) {
            conflicts.push({
              row: row.sheetRow,
              productId: row.productId,
              productName: existingProduct.name,
              fields: edits.conflicts,
            });
          }

          if (edits.changedFields.length || edits.variantChanges.length) {
            updated.push({
              row: row.sheetRow,
              productId: row.productId,
              productName: existingProduct.name,
              fields: edits.changedFields,
              variants: edits.variantChanges,
            });
          } else if (edits.stale.length) {
            skipped.push({
              row: row.sheetRow,
              productId: row.productId,
              reason: "MongoDB wins — the sheet row is older than a purchase",
            });
          } else {
            skipped.push({ row: row.sheetRow, productId: row.productId, reason: "No changes" });
          }

          continue;
        }
      }

      // Required fields
      if (!row.productName || !row.price || !row.category) {
        errors.push({ row: row.sheetRow, reason: "productName, price and category are required" });
        continue;
      }

      const categoryId = await resolveCategoryId(row.category);
      if (!categoryId) {
        errors.push({ row: row.sheetRow, reason: `Unknown category "${row.category}"` });
        continue;
      }

      const price = Number(row.price);
      if (isNaN(price) || price < 0) {
        errors.push({ row: row.sheetRow, reason: "Invalid price" });
        continue;
      }

      const stock = Number(row.stock || 0);
      if (isNaN(stock) || stock < 0 || !Number.isInteger(stock)) {
        errors.push({ row: row.sheetRow, reason: "Stock must be a non-negative whole number" });
        continue;
      }

      // Generate slug
      let slug = generateSlug(row.productName);
      const existingSlug = await Product.findOne({ slug }).select("_id").lean();
      if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;

      const tags = row.tags
        ? row.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
        : [];

      const imageUrls = row.imageUrls
        ? row.imageUrls.split(",").map((url) => url.trim()).filter(Boolean)
        : [];

      const images = imageUrls.map((url, index) => ({
        url,
        alt: row.productName,
        sortOrder: index,
      }));

      const hasVariants = parseBool(row.hasVariants);
      const freeShipping = parseBool(row.freeShipping);

      const discountType =
        row.discountType && row.discountType !== "None" ? row.discountType : null;
      const discountValue = Number(row.discountValue || 0);

      // Generate a description with Gemini when the seller left it blank
      let finalDescription = row.description || "";
      let aiDescription = "";
      let aiSellingPoints = [];

      if (!finalDescription.trim()) {
        try {
          const generated = await generateProductDescription({
            name: row.productName,
            category: row.category,
            attributes: [],
            features: tags,
          });

          finalDescription = generated.description || "";
          aiDescription = generated.description || "";
          aiSellingPoints = generated.sellingPoints || [];

          console.log(`Gemini description generated for: ${row.productName}`);
        } catch (aiError) {
          console.error(
            `Gemini description generation failed for ${row.productName}:`,
            aiError.message
          );
        }
      }

      if (aiDescription) {
        await updateProductDescriptionInSheet(row.sheetRow, aiDescription, spreadsheetId);
      }

      const status = VALID_STATUSES.includes(String(row.status || "").toLowerCase())
        ? String(row.status).toLowerCase()
        : "active";

      const product = await Product.create({
        seller: seller._id,
        store: storeId,
        name: row.productName,
        slug,

        description: finalDescription,
        aiDescription,
        aiSellingPoints,

        price,
        stock,
        category: categoryId,
        tags,
        images,
        hasVariants,
        variantOptions: [],
        discount: { type: discountType, value: discountValue },
        shipping: {
          weight: Number(row.weight || 0),
          shippingCost: Number(row.shippingCost || 0),
          freeShipping,
        },
        status,
        publishedAt: new Date(),
      });

      // Write the generated MongoDB id back so the row is never imported twice
      await updateProductIdInSheet(row.sheetRow, product._id.toString(), spreadsheetId);

      // The row and MongoDB now agree; imported products never carry variants
      // yet, so there is nothing per-variant to baseline.
      await rememberSheetBaseline(product, []);

      imported.push({
        row: row.sheetRow,
        productId: product._id.toString(),
        productName: product.name,
      });
    } catch (error) {
      errors.push({ row: row.sheetRow, reason: error.message });
    }
  }

  return { imported, updated, skipped, errors, conflicts };
}

/**
 * Run the importer for every store that has a spreadsheet attached.
 * One seller's failure never stops the others.
 */
export async function syncAllStoreSheets() {
  if (mongoose.connection.readyState !== 1) {
    console.warn("[SheetSync] Skipped — MongoDB is not connected");
    return [];
  }

  const stores = await Store.find({ "googleSheet.spreadsheetId": { $nin: ["", null] } })
    .select("name seller googleSheet")
    .lean();

  const results = [];

  for (const store of stores) {
    try {
      const seller = await Seller.findById(store.seller).select("_id isVerified isActive").lean();

      // Only approved, active sellers sync.
      if (!seller?.isVerified || !seller.isActive) continue;

      const outcome = await importProductsFromSheet({ seller, store });

      // Phase 10 — refresh the Inventory snapshot of stores that opted in. The
      // background job never creates the tab (createIfMissing: false), so a
      // store that never asked for one is left completely untouched.
      const inventory = await syncInventoryToSheet(store, { createIfMissing: false });

      results.push({ store: store.name, ...outcome, inventory });

      if (outcome.imported.length || outcome.updated.length) {
        console.log(
          `[SheetSync] ${store.name}: ${outcome.imported.length} new, ${outcome.updated.length} updated for seller ${seller._id}`
        );
      }
      for (const conflict of outcome.conflicts || []) {
        const fields = conflict.fields.map((field) => field.field).join(", ");
        console.warn(
          `[SheetSync] ${store.name} row ${conflict.row}: conflict on ${fields} — MongoDB wins, sheet corrected`
        );
      }
      for (const err of outcome.errors) {
        console.warn(`[SheetSync] ${store.name} row ${err.row}: ${err.reason}`);
      }
    } catch (error) {
      const message = error?.response?.data?.error?.message || error.message;
      console.error(`[SheetSync] ${store.name} failed: ${message}`);
      results.push({ store: store.name, error: message });
    }
  }

  return results;
}

/**
 * Start the background job that pulls new sheet rows into the app.
 * Defaults to every 5 minutes; override with SHEET_SYNC_INTERVAL_MS and turn
 * it off with SHEET_SYNC_ENABLED=false.
 */
export function startSheetSync(options = {}) {
  if (process.env.SHEET_SYNC_ENABLED === "false") {
    console.log("[SheetSync] Disabled via SHEET_SYNC_ENABLED=false");
    return null;
  }

  const intervalMs =
    Number(options.intervalMs ?? process.env.SHEET_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  const run = async () => {
    try {
      const results = await syncAllStoreSheets();
      const added = results.reduce((sum, r) => sum + (r.imported?.length || 0), 0);
      const changed = results.reduce((sum, r) => sum + (r.updated?.length || 0), 0);
      if (added || changed) {
        console.log(`[SheetSync] Cycle done — ${added} imported, ${changed} updated`);
      }
    } catch (error) {
      console.error("[SheetSync] Cycle failed:", error.message);
    }
  };

  const timer = setInterval(run, intervalMs);
  // Don't hold the event loop open on shutdown.
  timer.unref?.();

  console.log(`[SheetSync] Scheduled every ${Math.round(intervalMs / 60000)} min`);

  // Catch rows added while the server was down (skipped in tests).
  if (process.env.SHEET_SYNC_RUN_ON_START !== "false" && process.env.NODE_ENV !== "test") {
    run();
  }

  return timer;
}

export default startSheetSync;
