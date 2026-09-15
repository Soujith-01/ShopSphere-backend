/**
 * Phase 10 — the optional Inventory tab.
 *
 * A read-only, at-a-glance stock view for sellers, derived entirely from
 * MongoDB: one row per variant (sku, reserved stock, low-stock threshold are
 * variant-level concepts), and one row for products that have no variants.
 *
 * Unlike Orders (an append-only ledger) this tab is a *snapshot*: it is rebuilt
 * from MongoDB each time, so rows for products or variants that no longer exist
 * disappear instead of lingering as stale numbers. The tab is only created when
 * a seller asks for it (`createIfMissing`), so stores that never opted in are
 * left untouched.
 */
import mongoose from "mongoose";
import Store from "../models/Store.js";
import Product from "../models/Product.js";
import Variant from "../models/Variant.js";
import { INVENTORY_HEADERS, SHEET_TABS } from "./sheetTabs.js";
import {
  clearSheetValues,
  ensureSheetTab,
  updateSheetValues,
} from "./googleSheetsServices.js";

const INVENTORY_BODY_RANGE = `${SHEET_TABS.inventory}!A2:H`;

const toIso = (value) => (value ? new Date(value).toISOString() : "");

/**
 * Build the Inventory rows for a store's products.
 * Pure so it can be unit-tested without a spreadsheet.
 *
 * @param {object[]} products lean products ({ _id, name, stock, updatedAt })
 * @param {object[]} variants lean variants ({ product, sku, stock, reservedStock, lowStockThreshold, updatedAt })
 * @returns {Array<Array<string|number>>} rows matching INVENTORY_HEADERS
 */
export function buildInventoryRows(products = [], variants = []) {
  const variantsByProduct = new Map();
  for (const variant of variants) {
    const key = String(variant.product);
    if (!variantsByProduct.has(key)) variantsByProduct.set(key, []);
    variantsByProduct.get(key).push(variant);
  }

  const rows = [];

  for (const product of products) {
    const productVariants = variantsByProduct.get(String(product._id)) || [];
    const productUpdated = toIso(product.updatedAt);

    // No variants → the product's own stock is the inventory.
    if (productVariants.length === 0) {
      const stock = product.stock ?? 0;
      rows.push([
        String(product._id),
        product.name || "",
        "",
        stock,
        0,
        stock,
        "",
        productUpdated,
      ]);
      continue;
    }

    for (const variant of productVariants) {
      const stock = variant.stock ?? 0;
      const reserved = variant.reservedStock ?? 0;
      rows.push([
        String(product._id),
        product.name || "",
        variant.sku || "",
        stock,
        reserved,
        Math.max(0, stock - reserved),
        variant.lowStockThreshold ?? "",
        toIso(variant.updatedAt) || productUpdated,
      ]);
    }
  }

  return rows;
}

/**
 * Rebuild one store's Inventory tab from MongoDB.
 *
 * @param {object|string} storeOrId Store doc, store id, or lean store
 * @param {object} [options]
 * @param {boolean} [options.createIfMissing=true] create the tab when absent
 * @returns {Promise<object|null>} null when the store has no sheet or the sync failed
 */
export async function syncInventoryToSheet(storeOrId, options = {}) {
  const { createIfMissing = true } = options;

  try {
    const store = mongoose.isValidObjectId(storeOrId)
      ? await Store.findById(storeOrId).select("name googleSheet").lean()
      : storeOrId;

    const spreadsheetId = store?.googleSheet?.spreadsheetId;
    if (!spreadsheetId) return null;

    const tab = await ensureSheetTab(spreadsheetId, SHEET_TABS.inventory, INVENTORY_HEADERS, {
      create: createIfMissing,
    });

    if (!tab.exists) {
      return { spreadsheetId, rows: 0, skipped: "No Inventory tab yet" };
    }

    const products = await Product.find({ store: store._id })
      .select("name stock updatedAt")
      .lean();

    const variants = products.length
      ? await Variant.find({ product: { $in: products.map((product) => product._id) } })
          .select("product sku stock reservedStock lowStockThreshold updatedAt")
          .lean()
      : [];

    const rows = buildInventoryRows(products, variants);

    // Rebuild, don't append — this is a current-state view.
    await clearSheetValues(spreadsheetId, INVENTORY_BODY_RANGE);
    if (rows.length) {
      await updateSheetValues(spreadsheetId, INVENTORY_BODY_RANGE, rows);
    }

    console.log(`✅ [SheetInventory] ${store.name}: ${rows.length} rows`);
    return { spreadsheetId, rows: rows.length };
  } catch (error) {
    const message = error?.response?.data?.error?.message || error.message;
    console.error(`⚠️ [SheetInventory] Rebuild failed: ${message}`);
    return null;
  }
}

export default syncInventoryToSheet;
