/**
 * Orders tab — the seller-facing mirror of their own order items.
 *
 * Checkout already splits a cart into one sub-order per seller
 * (see APIS/customer/orders.js), and this service writes each sub-order into the
 * Orders tab of THAT SELLER'S OWN spreadsheet — never anyone else's:
 *
 *   Customer
 *      ↓ one checkout containing Seller A + Seller B items
 *      ↓ split into sub-orders (MongoDB)
 *   Seller A → Sheet A → Orders tab   (only Seller A's items)
 *   Seller B → Sheet B → Orders tab   (only Seller B's items)
 *
 * Destination spreadsheet = authenticated seller → their Store →
 * `store.googleSheet.spreadsheetId`. A seller id or spreadsheet id from a
 * request body is never trusted.
 *
 * One row per purchased item. A row's identity is
 * **orderId + productId + variantId**, so:
 *   - a checkout retried / page refreshed / duplicate request updates the same
 *     row instead of appending a duplicate (idempotent), and
 *   - a status change, cancellation or refund rewrites the row in place.
 *
 * Prices come from the order's own snapshots, never from the current Product
 * document — a later price change must not rewrite history.
 *
 * Best-effort everywhere: a Sheets outage only marks the sync `failed`. It must
 * never fail the customer's order (the order lives in MongoDB, which is the
 * source of truth).
 */
import mongoose from "mongoose";
import Store from "../models/Store.js";
import User from "../models/User.js";
import Order from "../models/Order.js";
import { ORDER_HEADERS } from "./sheetTabs.js";
import {
  addOrderToSheet,
  createOrdersSheet,
  getOrdersFromSheet,
  updateOrderInSheet,
} from "./googleSheetsServices.js";

// Ids may arrive as ObjectIds, populated documents or plain strings.
const toId = (value) => (value == null ? "" : String(value?._id ?? value));

// How far back a rebuilt Orders tab is repopulated from MongoDB.
const RESET_BACKFILL_LIMIT = 50;

const toIso = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

// One cell for the whole address, with the phone appended after a separator
// because a seller needs it to actually ship the parcel.
const formatShippingAddress = (address = {}) => {
  const parts = [address.fullName, address.street, address.pincode]
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  const phone = String(address.phone || "").trim();
  return phone ? `${parts.join(", ")} · ${phone}` : parts.join(", ");
};

/**
 * Build the Orders rows for one sub-order: one row per purchased item.
 *
 * Pure so the whole contract can be unit-tested without a spreadsheet
 * (see test/sheetSync.test.mjs).
 *
 * @param {object} order the validated MongoDB sub-order (prices are snapshots)
 * @param {object} [customer] { name, email } of the ordering customer
 * @returns {Array<object>} rows keyed by ORDER_HEADERS
 */
export function buildOrderRows(order, customer = {}) {
  const orderId = toId(order._id) || String(order.orderNumber || "");
  const sellerId = toId(order.seller);
  const customerId = toId(order.customer);
  const customerName = customer.name || order.shippingAddress?.fullName || "";
  const customerEmail = customer.email || "";

  // Server-side values only: never a price, total or status from the client.
  const paymentStatus = order.payment?.status || "";
  const orderStatus = order.status || "";
  const orderTotal = order.total ?? 0;
  const shippingCost = order.shippingCost ?? 0;
  const shippingAddress = formatShippingAddress(order.shippingAddress);
  const orderDate = toIso(order.createdAt);
  const updatedAt = toIso(order.updatedAt) || orderDate;

  return (order.items || []).map((item) => ({
    orderId,
    sellerId,
    customerId,
    customerName,
    customerEmail,

    productId: toId(item.product),
    productName: item.productName || "",
    // Blank (not "null") when the product has no variant.
    variantId: toId(item.variant),
    variantLabel: item.variantLabel || "",
    sku: item.sku || "",

    quantity: item.quantity ?? 0,
    unitPrice: item.price ?? 0, // item snapshot
    discount: item.discount ?? 0, // item snapshot
    shippingCost, // order-level
    tax: item.tax ?? 0, // item snapshot
    itemTotal: item.total ?? 0, // item snapshot
    orderTotal, // order-level

    paymentStatus,
    orderStatus,
    shippingAddress,
    orderDate,
    updatedAt,
  }));
}

/**
 * Row identity for idempotency: orderId + productId + variantId.
 * @returns {string}
 */
export function orderRowKey(row) {
  return [row?.orderId || "", row?.productId || "", row?.variantId || ""].join("::");
}

/**
 * Decide, for a batch of rows, which ones already exist in the sheet (→ update
 * that row in place) and which are new (→ append).
 *
 * Pure. A key maps to a QUEUE of rows: one order can legitimately hold two
 * variants of the same product, and each must keep its own row.
 *
 * @param {Array<object>} existingRows rows read from the sheet (with `sheetRow`)
 * @param {Array<object>} rows rows just built from MongoDB
 * @returns {{appends: Array<object>, updates: Array<{row: number, values: object}>}}
 */
export function planOrderWrites(existingRows = [], rows = []) {
  const rowsByKey = new Map();

  for (const existing of existingRows) {
    const key = orderRowKey(existing);
    if (!rowsByKey.has(key)) rowsByKey.set(key, []);
    rowsByKey.get(key).push(existing);
  }

  const appends = [];
  const updates = [];

  for (const row of rows) {
    const match = rowsByKey.get(orderRowKey(row))?.shift();

    if (match?.sheetRow) updates.push({ row: match.sheetRow, values: row });
    else appends.push(row);
  }

  return { appends, updates };
}

// Sync bookkeeping on the Order. Deliberately does not touch `updatedAt`: the
// sheet's updatedAt column follows real business changes, not sheet writes.
async function markSyncStatus(orderIds, { status, error = "" }) {
  const ids = (orderIds || []).filter((id) => mongoose.isValidObjectId(id));
  if (ids.length === 0) return;

  try {
    const update = { googleSheetSyncStatus: status, googleSheetSyncError: error || "" };
    if (status === "synced") update.googleSheetSyncedAt = new Date();

    await Order.updateMany({ _id: { $in: ids } }, { $set: update }, { timestamps: false });
  } catch (dbError) {
    console.error(`⚠️ [SheetOrders] Could not record sync status: ${dbError.message}`);
  }
}

async function writeOrders(spreadsheetId, orders, customerById) {
  // Creates the tab + headers when missing, and resets a tab written by an
  // older schema (rows are re-read after that, so the reset is honoured).
  const sheet = await createOrdersSheet(spreadsheetId);

  const existingRows = await getOrdersFromSheet(spreadsheetId);

  const rows = orders.flatMap((order) =>
    buildOrderRows(order, customerById.get(toId(order.customer)) || {})
  );

  // A reset tab just lost the rows written by the older schema, so repopulate
  // this seller's recent order history in the same pass — otherwise their Orders
  // tab would stay half-empty until somebody ran a manual sync.
  if (sheet.reset) {
    const sellerIds = [...new Set(orders.map((order) => toId(order.seller)))].filter((id) =>
      mongoose.isValidObjectId(id)
    );

    for (const sellerId of sellerIds) {
      const history = await Order.find({ seller: sellerId })
        .sort({ createdAt: 1 })
        .limit(RESET_BACKFILL_LIMIT)
        .lean();

      // Customer details for the backfilled orders may not be in the map yet.
      const missingCustomerIds = [...new Set(history.map((order) => toId(order.customer)))].filter(
        (id) => mongoose.isValidObjectId(id) && !customerById.has(id)
      );

      if (missingCustomerIds.length) {
        const extraCustomers = await User.find({ _id: { $in: missingCustomerIds } })
          .select("name email")
          .lean();
        for (const customer of extraCustomers) customerById.set(String(customer._id), customer);
      }

      rows.push(
        ...history.flatMap((order) =>
          buildOrderRows(order, customerById.get(toId(order.customer)) || {})
        )
      );
    }
  }

  // Keep the freshest row per identity: the history backfill can include the very
  // order being synced, and a batch must never contain the same key twice.
  const deduped = [...new Map(rows.map((row) => [orderRowKey(row), row])).values()];

  const { appends, updates } = planOrderWrites(existingRows, deduped);

  for (const update of updates) {
    await updateOrderInSheet(update.row, update.values, spreadsheetId);
  }

  if (appends.length) await addOrderToSheet(appends, spreadsheetId);

  return {
    orders: orders.length,
    appended: appends.length,
    updated: updates.length,
    reset: Boolean(sheet.reset),
  };
}

/**
 * Write one or more sub-orders into their sellers' Orders tabs, batching by
 * spreadsheet so a multi-vendor checkout costs one Sheets round-trip per seller
 * instead of one per item.
 *
 * Callers await this, but it never throws: MongoDB already holds the order.
 *
 * @returns {Promise<Array<object>>} per-spreadsheet outcome
 */
export async function syncOrdersToSheet(orders = []) {
  const list = (orders || []).filter(Boolean);
  if (list.length === 0) return [];

  try {
    const storeIds = [...new Set(list.map((order) => toId(order.store)))].filter((id) =>
      mongoose.isValidObjectId(id)
    );
    const customerIds = [...new Set(list.map((order) => toId(order.customer)))].filter((id) =>
      mongoose.isValidObjectId(id)
    );

    const [stores, customers] = await Promise.all([
      storeIds.length
        ? Store.find({ _id: { $in: storeIds } }).select("name googleSheet").lean()
        : [],
      customerIds.length
        ? User.find({ _id: { $in: customerIds } }).select("name email").lean()
        : [],
    ]);

    const storeById = new Map(stores.map((store) => [String(store._id), store]));
    const customerById = new Map(customers.map((customer) => [String(customer._id), customer]));

    // Group by spreadsheet: each seller's items go to that seller's own sheet.
    const groups = new Map();
    const results = [];
    const noSheetOrders = [];

    for (const order of list) {
      const store = storeById.get(toId(order.store));
      const spreadsheetId = store?.googleSheet?.spreadsheetId;

      // No store sheet yet — nothing to mirror into (the store page creates it).
      if (!spreadsheetId) {
        noSheetOrders.push(toId(order._id));
        results.push({ order: toId(order._id), appended: 0, updated: 0, sheet: null });
        continue;
      }

      if (!groups.has(spreadsheetId)) groups.set(spreadsheetId, []);
      groups.get(spreadsheetId).push(order);
    }

    for (const [spreadsheetId, groupOrders] of groups) {
      try {
        const summary = await writeOrders(spreadsheetId, groupOrders, customerById);

        await markSyncStatus(
          groupOrders.map((order) => toId(order._id)),
          { status: "synced" }
        );

        console.log(
          `✅ [SheetOrders] ${summary.appended} appended, ${summary.updated} updated on ${spreadsheetId}`
        );
        results.push({ spreadsheetId, ...summary });
      } catch (error) {
        const message = error?.response?.data?.error?.message || error.message;

        await markSyncStatus(
          groupOrders.map((order) => toId(order._id)),
          { status: "failed", error: message }
        );

        // Order ids, seller(s) and spreadsheet, so a failure is diagnosable.
        console.error(
          `⚠️ [SheetOrders] Sync failed — orders=${groupOrders
            .map((order) => toId(order._id))
            .join(",")} sellers=${[...new Set(groupOrders.map((order) => toId(order.seller)))].join(
            ","
          )} spreadsheet=${spreadsheetId}: ${message}`
        );

        results.push({ spreadsheetId, error: message });
      }
    }

    if (noSheetOrders.length) {
      console.warn(
        `[SheetOrders] No Google Sheet yet for orders ${noSheetOrders.join(",")} — left pending`
      );
    }

    return results;
  } catch (error) {
    // Last-resort guard: the sheet mirror must never break the caller's flow
    // (a customer's order is already committed in MongoDB at this point).
    const message = error?.response?.data?.error?.message || error.message;
    console.error(`⚠️ [SheetOrders] Sync aborted before writing: ${message}`);

    await markSyncStatus(
      list.map((order) => toId(order._id)),
      { status: "failed", error: message }
    );

    return [{ error: message }];
  }
}

/**
 * Mirror a single sub-order (checkout, status change, cancellation, refund).
 * @returns {Promise<object|null>} the outcome for that order's spreadsheet
 */
export async function syncOrderToSheet(order) {
  const results = await syncOrdersToSheet([order]);
  return results[0] ?? null;
}

/**
 * Rewrite a seller's recent orders into their Orders tab, oldest first, so a tab
 * that was just created (or reset by a schema change) is populated again.
 *
 * @param {string|object} sellerId
 * @param {string} spreadsheetId
 * @param {number} [limit]
 */
export async function syncSellerOrdersToSheet(sellerId, spreadsheetId, limit = 50) {
  if (!spreadsheetId || !mongoose.isValidObjectId(sellerId)) return null;

  const orders = await Order.find({ seller: sellerId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  if (orders.length === 0) return { orders: 0, appended: 0, updated: 0 };

  // Oldest first so rows read chronologically in the sheet.
  return (await syncOrdersToSheet(orders.reverse()))[0] ?? null;
}

export default syncOrderToSheet;
