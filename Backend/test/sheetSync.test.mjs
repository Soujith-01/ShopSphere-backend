import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MONGO,
  SHEET,
  readSheetNumber,
  resolveFieldConflict,
  resolveFieldConflicts,
} from "../services/sheetConflicts.js";
import { buildOrderRows, orderRowKey, planOrderWrites } from "../services/sheetOrders.js";
import { buildInventoryRows } from "../services/sheetInventory.js";
import {
  INVENTORY_HEADERS,
  ORDER_HEADERS,
  PRODUCT_HEADERS,
  buildSheetTabUrl,
  spreadsheetUrlFor,
} from "../services/sheetTabs.js";

// ---------------------------------------------------------------------------
// Phase 8 — the conflict rule
// ---------------------------------------------------------------------------

test("readSheetNumber coerces sheet cells and rejects blanks", () => {
  assert.equal(readSheetNumber(25), 25);
  assert.equal(readSheetNumber("25"), 25);
  assert.equal(readSheetNumber(" 25 "), 25);
  assert.equal(readSheetNumber("1500.50"), 1500.5);
  assert.equal(readSheetNumber(0), 0);
  assert.equal(readSheetNumber(""), null);
  assert.equal(readSheetNumber("   "), null);
  assert.equal(readSheetNumber(null), null);
  assert.equal(readSheetNumber(undefined), null);
  assert.equal(readSheetNumber("out of stock"), null);
});

test("a blank sheet cell never overwrites MongoDB", () => {
  const decision = resolveFieldConflict({ sheetValue: null, mongoValue: 20, baseline: 20 });
  assert.deepEqual(decision, { winner: MONGO, value: 20, conflict: false, stale: false });
});

test("matching values need no write and no correction", () => {
  const decision = resolveFieldConflict({ sheetValue: 20, mongoValue: 20, baseline: 20 });
  assert.equal(decision.conflict, false);
  assert.equal(decision.stale, false);
});

test("without a baseline the sheet stays authoritative (legacy rows)", () => {
  const decision = resolveFieldConflict({ sheetValue: 25, mongoValue: 20, baseline: null });
  assert.equal(decision.winner, SHEET);
  assert.equal(decision.value, 25);
  assert.equal(decision.conflict, false);
  assert.equal(decision.stale, false);
});

test("a NaN/undefined baseline counts as no baseline", () => {
  assert.equal(resolveFieldConflict({ sheetValue: 25, mongoValue: 20 }).winner, SHEET);
  assert.equal(resolveFieldConflict({ sheetValue: 25, mongoValue: 20, baseline: NaN }).winner, SHEET);
});

test("only the seller moving the sheet → the sheet edit wins", () => {
  // baseline 20, seller types 25, MongoDB untouched at 20
  const decision = resolveFieldConflict({ sheetValue: 25, mongoValue: 20, baseline: 20 });
  assert.equal(decision.winner, SHEET);
  assert.equal(decision.value, 25);
  assert.equal(decision.conflict, false);
  assert.equal(decision.stale, false);
});

test("only MongoDB moving → MongoDB wins and the stale sheet is corrected", () => {
  // A purchase (20 → 18) whose sheet write never landed: the row still shows 20.
  const decision = resolveFieldConflict({ sheetValue: 20, mongoValue: 18, baseline: 20 });
  assert.equal(decision.winner, MONGO);
  assert.equal(decision.value, 18);
  assert.equal(decision.conflict, false);
  assert.equal(decision.stale, true);
});

test("both sides moving is a conflict and the purchase wins", () => {
  // The Phase 8 example: MongoDB 20 → 18 by a purchase while the seller's stale
  // sheet row is edited from 20 to 25.
  const decision = resolveFieldConflict({ sheetValue: 25, mongoValue: 18, baseline: 20 });
  assert.equal(decision.winner, MONGO);
  assert.equal(decision.value, 18);
  assert.equal(decision.conflict, true);
  assert.equal(decision.stale, true);
});

test("resolveFieldConflicts splits applied edits from corrections", () => {
  const { changes, stale, conflicts } = resolveFieldConflicts([
    // seller raised stock 20 → 25, MongoDB untouched → applied
    { field: "stock", sheet: 25, mongo: 20, baseline: 20 },
    // price edited in the sheet while a purchase also moved nothing → applied
    { field: "price", sheet: 1300, mongo: 1500, baseline: 1500 },
    // variant stock: both sides moved → conflict, MongoDB wins
    { field: "variantStock", sheet: 9, mongo: 4, baseline: 6 },
  ]);

  assert.deepEqual(changes, { stock: 25, price: 1300 });
  assert.deepEqual(stale, [{ field: "variantStock", sheet: 9, mongo: 4 }]);
  assert.deepEqual(conflicts, [{ field: "variantStock", sheet: 9, mongo: 4 }]);
});

test("resolveFieldConflicts ignores a field nobody changed", () => {
  const { changes, stale, conflicts } = resolveFieldConflicts([
    { field: "stock", sheet: 20, mongo: 20, baseline: 20 },
    { field: "price", sheet: "", mongo: 999, baseline: 999 },
  ]);
  assert.deepEqual(changes, {});
  assert.deepEqual(stale, []);
  assert.deepEqual(conflicts, []);
});

// ---------------------------------------------------------------------------
// Orders tab rows
// ---------------------------------------------------------------------------

const sampleOrder = {
  _id: "order1",
  orderNumber: "ORD-2026-00001",
  customer: { _id: "customer1" },
  seller: "seller1",
  store: "store1",
  status: "placed",
  payment: { status: "pending" },
  shippingCost: 40,
  tax: 0,
  discount: 0,
  total: 3239,
  createdAt: new Date("2026-09-15T10:00:00.000Z"),
  updatedAt: new Date("2026-09-15T10:05:00.000Z"),
  shippingAddress: {
    fullName: "Asha Rao",
    phone: "9876543210",
    street: "12 MG Road",
    pincode: "560001",
  },
  items: [
    {
      product: { _id: "product1" },
      variant: null,
      productName: "Running Shoes",
      quantity: 2,
      price: 1500,
      discount: 0,
      tax: 0,
      total: 3000,
      variantLabel: "",
      sku: "",
    },
    {
      product: "product2",
      variant: { _id: "variant1" },
      productName: "T-Shirt",
      quantity: 1,
      price: 199,
      discount: 0,
      tax: 0,
      total: 199,
      variantLabel: "Red / M",
      sku: "TSH-RED-M",
    },
  ],
};

const sampleCustomer = { name: "Asha Rao", email: "asha@example.com" };

test("buildOrderRows writes one row per purchased item with every column filled", () => {
  const rows = buildOrderRows(sampleOrder, sampleCustomer);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    orderId: "order1",
    sellerId: "seller1",
    customerId: "customer1",
    customerName: "Asha Rao",
    customerEmail: "asha@example.com",
    productId: "product1",
    productName: "Running Shoes",
    variantId: "",
    variantLabel: "",
    sku: "",
    quantity: 2,
    unitPrice: 1500,
    discount: 0,
    shippingCost: 40,
    tax: 0,
    itemTotal: 3000,
    orderTotal: 3239,
    paymentStatus: "pending",
    orderStatus: "placed",
    shippingAddress: "Asha Rao, 12 MG Road, 560001 · 9876543210",
    orderDate: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:05:00.000Z",
  });

  // Every row carries exactly the schema's columns, nothing more or less.
  assert.deepEqual(Object.keys(rows[0]).sort(), [...ORDER_HEADERS].sort());
});

test("buildOrderRows stores variant id, label and sku for variant purchases", () => {
  const [, variantRow] = buildOrderRows(sampleOrder, sampleCustomer);

  assert.equal(variantRow.productName, "T-Shirt");
  assert.equal(variantRow.variantId, "variant1");
  assert.equal(variantRow.variantLabel, "Red / M");
  assert.equal(variantRow.sku, "TSH-RED-M");
  assert.equal(variantRow.quantity, 1);

  // No variant → blank cells, not the string "null".
  const [plainRow] = buildOrderRows(sampleOrder, sampleCustomer);
  assert.equal(plainRow.variantId, "");
  assert.equal(plainRow.variantLabel, "");
  assert.equal(plainRow.sku, "");
});

test("buildOrderRows tolerates a sub-order without items", () => {
  assert.deepEqual(buildOrderRows({ ...sampleOrder, items: [] }), []);
  assert.deepEqual(buildOrderRows({ ...sampleOrder, items: undefined }), []);
});

test("order rows mirror MongoDB status and payment values", () => {
  const delivered = {
    ...sampleOrder,
    status: "delivered",
    payment: { status: "completed" },
  };
  const [row] = buildOrderRows(delivered, sampleCustomer);

  assert.equal(row.paymentStatus, "completed");
  assert.equal(row.orderStatus, "delivered");

  // A cancellation is just another mirrored value — no invented vocabulary.
  const [cancelled] = buildOrderRows({ ...delivered, status: "cancelled" }, sampleCustomer);
  assert.equal(cancelled.orderStatus, "cancelled");
});

test("prices come from the order snapshot, never the current product", () => {
  const [row, variantRow] = buildOrderRows(sampleOrder, sampleCustomer);

  // unitPrice / itemTotal are the checkout snapshots...
  assert.equal(row.unitPrice, 1500);
  assert.equal(row.itemTotal, 3000);
  assert.equal(variantRow.unitPrice, 199);
  assert.equal(variantRow.itemTotal, 199);

  // ...while shippingCost and orderTotal belong to the order as a whole and are
  // repeated on every row of that order.
  assert.equal(row.shippingCost, variantRow.shippingCost);
  assert.equal(row.orderTotal, variantRow.orderTotal);

  // Re-pricing the product later cannot rewrite the rows: the builder only ever
  // reads the order document.
  const repricedProduct = { _id: "product1", price: 1800 };
  const again = buildOrderRows(sampleOrder, sampleCustomer);
  assert.equal(repricedProduct.price, 1800);
  assert.equal(again[0].unitPrice, 1500);
});

test("a multi-vendor checkout never leaks one seller's items into another's rows", () => {
  const sellerA = buildOrderRows(
    {
      ...sampleOrder,
      _id: "orderA",
      seller: "sellerA",
      items: [
        { product: "shoesA", productName: "Shoes", quantity: 2, price: 500, total: 1000 },
        { product: "shirtA", productName: "T-Shirt", quantity: 1, price: 300, total: 300 },
      ],
    },
    sampleCustomer
  );

  const sellerB = buildOrderRows(
    {
      ...sampleOrder,
      _id: "orderB",
      seller: "sellerB",
      items: [{ product: "headphonesB", productName: "Headphones", quantity: 1, price: 900, total: 900 }],
    },
    sampleCustomer
  );

  // Seller A owns two rows, Seller B one — and nothing crossed over.
  assert.deepEqual(sellerA.map((row) => row.productId), ["shoesA", "shirtA"]);
  assert.deepEqual(sellerB.map((row) => row.productId), ["headphonesB"]);

  assert.ok(sellerA.every((row) => row.sellerId === "sellerA"));
  assert.ok(sellerB.every((row) => row.sellerId === "sellerB"));

  const aProducts = new Set(sellerA.map((row) => row.productId));
  assert.ok(sellerB.every((row) => !aProducts.has(row.productId)));
});

test("orderRowKey separates variants of the same product", () => {
  const base = { orderId: "o1", productId: "p1" };

  assert.notEqual(
    orderRowKey({ ...base, variantId: "v1" }),
    orderRowKey({ ...base, variantId: "v2" })
  );
  assert.notEqual(orderRowKey({ ...base, variantId: "v1" }), orderRowKey(base));
  assert.equal(orderRowKey({ ...base, variantId: "" }), orderRowKey(base));
});

test("re-syncing the same order updates its rows instead of duplicating them", () => {
  const rows = buildOrderRows(sampleOrder, sampleCustomer);

  // First sync: the tab is empty → both items are appended.
  const first = planOrderWrites([], rows);
  assert.equal(first.appends.length, 2);
  assert.equal(first.updates.length, 0);

  // Second sync (page refresh / retry / duplicate request): the tab already has
  // the rows, so each one is updated in place — no duplicates.
  const existing = [
    { ...rows[0], sheetRow: 2 },
    { ...rows[1], sheetRow: 3 },
  ];
  const second = planOrderWrites(existing, buildOrderRows(sampleOrder, sampleCustomer));
  assert.equal(second.appends.length, 0);
  assert.deepEqual(second.updates.map((entry) => entry.row), [2, 3]);

  // A status change lands in the same rows.
  const shipped = planOrderWrites(existing, buildOrderRows({ ...sampleOrder, status: "shipped" }, sampleCustomer));
  assert.equal(shipped.appends.length, 0);
  assert.equal(shipped.updates.length, 2);
  assert.equal(shipped.updates[0].values.orderStatus, "shipped");
});

test("a repeated item key reuses the queued row before appending another", () => {
  const rows = buildOrderRows(sampleOrder, sampleCustomer);

  // Same key present only once in the sheet → the duplicate is a fresh append.
  const oneRow = planOrderWrites([{ ...rows[0], sheetRow: 7 }], rows);
  assert.equal(oneRow.updates.length, 1);
  assert.equal(oneRow.updates[0].row, 7);
  assert.equal(oneRow.appends.length, 1);
  assert.equal(oneRow.appends[0].productId, "product2");
});

// ---------------------------------------------------------------------------
// Phase 10 — Inventory tab rows
// ---------------------------------------------------------------------------

test("buildInventoryRows lists one row per variant with available stock", () => {
  const products = [
    { _id: "p1", name: "T-Shirt", stock: 10, updatedAt: new Date("2026-09-10T00:00:00.000Z") },
    { _id: "p2", name: "Mug", stock: 7, updatedAt: new Date("2026-09-11T00:00:00.000Z") },
  ];
  const variants = [
    {
      product: "p1",
      sku: "TS-RED-S",
      stock: 4,
      reservedStock: 1,
      lowStockThreshold: 2,
      updatedAt: new Date("2026-09-12T00:00:00.000Z"),
    },
    { product: "p1", sku: "TS-BLUE-M", stock: 6, reservedStock: 0, lowStockThreshold: 2 },
  ];

  const rows = buildInventoryRows(products, variants);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], [
    "p1",
    "T-Shirt",
    "TS-RED-S",
    4,
    1,
    3,
    2,
    "2026-09-12T00:00:00.000Z",
  ]);
  // No updatedAt on the variant → falls back to the product's
  assert.equal(rows[1][2], "TS-BLUE-M");
  assert.equal(rows[1][5], 6);
  assert.equal(rows[1][7], "2026-09-10T00:00:00.000Z");
  // A product without variants uses its own stock, with no sku/threshold
  assert.deepEqual(rows[2], ["p2", "Mug", "", 7, 0, 7, "", "2026-09-11T00:00:00.000Z"]);
  rows.forEach((row) => assert.equal(row.length, INVENTORY_HEADERS.length));
});

test("buildInventoryRows never reports negative available stock", () => {
  const rows = buildInventoryRows(
    [{ _id: "p1", name: "Mug", stock: 2 }],
    [{ product: "p1", sku: "MUG", stock: 1, reservedStock: 3 }]
  );
  assert.equal(rows[0][4], 3); // reservedStock
  assert.equal(rows[0][5], 0); // availableStock clamped at 0
});

test("buildInventoryRows returns nothing for an empty store", () => {
  assert.deepEqual(buildInventoryRows(), []);
  assert.deepEqual(buildInventoryRows([], []), []);
});

// ---------------------------------------------------------------------------
// Tab schemas are the contract every sync relies on
// ---------------------------------------------------------------------------

test("buildSheetTabUrl deep-links one tab by gid", () => {
  const url = "https://docs.google.com/spreadsheets/d/abc123/edit";

  // The Orders tab must be targeted so the dashboard never opens Products.
  assert.equal(buildSheetTabUrl(url, 987654), `${url}#gid=987654`);
  assert.equal(buildSheetTabUrl(`${url}#gid=111`, 987654), `${url}#gid=987654`);

  // No gid → plain spreadsheet link; no spreadsheet → nothing to open.
  assert.equal(buildSheetTabUrl(url, undefined), url);
  assert.equal(buildSheetTabUrl(url, null), url);
  assert.equal(buildSheetTabUrl("", 123), "");
  assert.equal(buildSheetTabUrl(undefined, 123), "");
});

test("spreadsheetUrlFor rebuilds a link from a bare spreadsheet id", () => {
  assert.equal(
    spreadsheetUrlFor("abc123"),
    "https://docs.google.com/spreadsheets/d/abc123/edit"
  );
  assert.equal(spreadsheetUrlFor(""), "");
});

test("tab schemas keep the column order the sync services write", () => {
  assert.deepEqual(PRODUCT_HEADERS.slice(0, 6), [
    "productId",
    "sellerId",
    "productName",
    "description",
    "price",
    "stock",
  ]);
  // Exactly the agreed column order — the sheet's contract with the seller.
  assert.deepEqual(ORDER_HEADERS, [
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
  ]);
  assert.deepEqual(INVENTORY_HEADERS, [
    "productId",
    "productName",
    "sku",
    "currentStock",
    "reservedStock",
    "availableStock",
    "lowStockThreshold",
    "lastUpdated",
  ]);
});
