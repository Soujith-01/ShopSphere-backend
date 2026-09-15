/**
 * The tab layout of a seller's spreadsheet.
 *
 * Every tab is a mirror of part of MongoDB for one store — the sheet is the
 * seller's admin view, MongoDB is the transactional source of truth (Phase 8).
 *
 *   Products  — written by services/sheetSync.js (two-way: rows are imported
 *               into the app and app changes are mirrored back)
 *   Orders    — written by services/sheetOrders.js (one row per order item, so a
 *               multi-vendor checkout lands in each seller's own sheet)
 *   Inventory — written by services/sheetInventory.js (rebuilt from MongoDB)
 *
 * Header names are part of the contract: rows are read back by header name, so
 * adding a column means adding it at the END of the list.
 */
export const SHEET_TABS = {
  products: "Products",
  orders: "Orders",
  inventory: "Inventory",
};

export const PRODUCT_HEADERS = [
  "productId",
  "sellerId",
  "productName",
  "description",
  "price",
  "stock",
  "discountType",
  "discountValue",
  "category",
  "tags",
  "imageUrls",
  "weight",
  "shippingCost",
  "freeShipping",
  "hasVariants",
  "variants",
  "status",
  "createdAt",
  "updatedAt",
];

/**
 * Orders tab — one row PER PURCHASED ITEM, in exactly this column order.
 *
 * Multi-vendor safe by construction: every row carries the `sellerId` of the
 * seller whose spreadsheet it was written to, and a single customer order with
 * products from two sellers produces rows in each seller's own sheet only.
 *
 * Levels (so a spreadsheet sum never double-counts):
 *   item-level   unitPrice, discount, tax, itemTotal  ← the price snapshot taken
 *                when the order was placed, never recalculated from the
 *                (possibly re-priced) Product document
 *   order-level  shippingCost, orderTotal             ← repeated on every row of
 *                that order, since they belong to the shipment as a whole
 *
 * `orderStatus` and `paymentStatus` mirror MongoDB verbatim (`placed`, `packed`,
 * `out_for_delivery`, `refunded`, …). MongoDB stays the source of truth — the
 * sheet never invents a transition.
 */
export const ORDER_HEADERS = [
  "orderId",
  "sellerId",
  "customerId",
  "customerName",
  "customerEmail",
  "productId",
  "productName",
  "variantId",
  "variantLabel",
  "sku",
  "quantity",
  "unitPrice",
  "discount",
  "shippingCost",
  "tax",
  "itemTotal",
  "orderTotal",
  "paymentStatus",
  "orderStatus",
  "shippingAddress",
  "orderDate",
  "updatedAt",
];

export const INVENTORY_HEADERS = [
  "productId",
  "productName",
  "sku",
  "currentStock",
  "reservedStock",
  "availableStock",
  "lowStockThreshold",
  "lastUpdated",
];

// Fallback for stores whose sheet exists but whose stored URL was never filled in.
export const spreadsheetUrlFor = (spreadsheetId) =>
  spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : "";

/**
 * Deep link that opens ONE tab of a spreadsheet.
 * Google Sheets addresses a tab by its numeric id, e.g.
 *   https://docs.google.com/spreadsheets/d/<id>/edit#gid=123456789
 * Without a gid the spreadsheet opens on whichever tab was last used.
 *
 * @param {string} spreadsheetUrl the store's stored spreadsheet link
 * @param {number|string} [gid] target tab id
 * @returns {string} "" when there is no spreadsheet to open
 */
export function buildSheetTabUrl(spreadsheetUrl, gid) {
  const base = String(spreadsheetUrl || "").split("#")[0];
  if (!base) return "";
  if (gid === undefined || gid === null || gid === "") return base;
  return `${base}#gid=${gid}`;
}

export default SHEET_TABS;
