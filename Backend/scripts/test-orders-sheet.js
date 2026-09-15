// Live check of the seller Orders tab against the real Google Sheets API.
//
//   cd Backend && node scripts/test-orders-sheet.js
//
// Creates a THROWAWAY spreadsheet (same code path as a real seller store), runs
// the Orders-tab contract against it, and deletes the spreadsheet at the end:
//
//   TEST 1  a new seller spreadsheet contains Products + Orders
//   TEST 2  the Orders tab has the exact 22 headers, in order
//   TEST 6  re-syncing the same order does not duplicate rows
//   TEST 7  a status change rewrites the existing row (no second row)
//   TEST 12 one row per purchased item
//
// It talks to Sheets directly (no HTTP server, no database), so it isolates the
// contract between services/sheetOrders.js and services/googleSheetsServices.js.
import "dotenv/config";
import { pathToFileURL } from "node:url";

import {
  addOrderToSheet,
  createOrdersSheet,
  deleteSpreadsheet,
  findOrderRowInSheet,
  getOrdersFromSheet,
  getSheetTitles,
  getSheetValues,
  updateOrderInSheet,
} from "../services/googleSheetsServices.js";
import { ORDER_HEADERS, SHEET_TABS } from "../services/sheetTabs.js";
import { buildOrderRows, planOrderWrites } from "../services/sheetOrders.js";

let failures = 0;

const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`✅ ${label}`);
  } else {
    failures += 1;
    console.error(`❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// A synthetic sub-order: two items, one of them a variant, from one seller.
const makeOrder = (status = "placed") => ({
  _id: "testorder000000000000001",
  orderNumber: "ORD-TEST-0001",
  customer: { _id: "testcustomer00000000001" },
  seller: "testseller000000000001",
  store: "teststore0000000000001",
  status,
  payment: { status: status === "delivered" ? "completed" : "pending" },
  shippingCost: 40,
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
      product: "testproduct000000000001",
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
      product: "testproduct000000000002",
      variant: "testvariant000000000001",
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
});

const customer = { name: "Asha Rao", email: "asha@example.com" };

async function main() {
  const { createSellerSpreadsheet } = await import("../services/googleSheetsServices.js");

  // A throwaway spreadsheet — no email passed, so nobody is notified.
  const created = await createSellerSpreadsheet(`ShopSphere Orders Test ${Date.now()}`);
  const spreadsheetId = created.spreadsheetId;
  console.log(`\n📄 Created test spreadsheet ${spreadsheetId}\n`);

  try {
    const tabs = await getSheetTitles(spreadsheetId);

    // TEST 1 — Products + Orders on a brand-new seller spreadsheet.
    check("TEST 1: new spreadsheet has Products + Orders", tabs.includes(SHEET_TABS.products) && tabs.includes(SHEET_TABS.orders), tabs.join(", "));

    // Idempotent tab creation: a second call must not duplicate or reset it.
    const second = await createOrdersSheet(spreadsheetId);
    const tabsAfter = await getSheetTitles(spreadsheetId);
    check(
      "TEST 1: re-running createOrdersSheet neither duplicates nor resets the tab",
      second.created === false && second.reset === false && tabsAfter.length === tabs.length,
      JSON.stringify(second)
    );

    // TEST 2 — headers, in the agreed order.
    const headerRow = (await getSheetValues(spreadsheetId, `${SHEET_TABS.orders}!A1:V1`))[0] || [];
    check(
      "TEST 2: Orders headers match ORDER_HEADERS exactly, in order",
      headerRow.length === ORDER_HEADERS.length && ORDER_HEADERS.every((h, i) => headerRow[i] === h),
      headerRow.join(" | ")
    );

    // TEST 12 — one row per purchased item.
    const rows = buildOrderRows(makeOrder(), customer);
    const firstPlan = planOrderWrites([], rows);
    await addOrderToSheet(firstPlan.appends, spreadsheetId);

    let sheetRows = await getOrdersFromSheet(spreadsheetId);
    check("TEST 12: one row per purchased item (2 items → 2 rows)", sheetRows.length === 2, `got ${sheetRows.length}`);

    const variantRow = sheetRows.find((row) => row.productId === "testproduct000000000002");
    check(
      "variant columns are written (variantId / label / sku / quantity)",
      variantRow?.variantId === "testvariant000000000001" &&
        variantRow?.variantLabel === "Red / M" &&
        variantRow?.sku === "TSH-RED-M" &&
        String(variantRow?.quantity) === "1",
      JSON.stringify(variantRow)
    );
    check(
      "order-level values are repeated on every row",
      sheetRows.every((row) => String(row.orderTotal) === "3239" && String(row.shippingCost) === "40")
    );

    // TEST 6 — re-syncing the same order must not duplicate rows.
    const retry = planOrderWrites(sheetRows, buildOrderRows(makeOrder(), customer));
    check("TEST 6: re-sync plans updates, not appends", retry.appends.length === 0 && retry.updates.length === 2, JSON.stringify({ appends: retry.appends.length, updates: retry.updates.length }));

    for (const update of retry.updates) await updateOrderInSheet(update.row, update.values, spreadsheetId);
    sheetRows = await getOrdersFromSheet(spreadsheetId);
    check("TEST 6: row count unchanged after the retry", sheetRows.length === 2, `got ${sheetRows.length}`);

    // TEST 7 — a status change rewrites the existing row in place.
    const shipped = planOrderWrites(sheetRows, buildOrderRows(makeOrder("shipped"), customer));
    for (const update of shipped.updates) await updateOrderInSheet(update.row, update.values, spreadsheetId);
    sheetRows = await getOrdersFromSheet(spreadsheetId);

    check("TEST 7: status change does not add a row", sheetRows.length === 2, `got ${sheetRows.length}`);
    check(
      "TEST 7: every row shows the new status + timestamp",
      sheetRows.every((row) => row.orderStatus === "shipped" && row.updatedAt === "2026-09-15T10:05:00.000Z"),
      sheetRows.map((row) => `${row.orderStatus}/${row.updatedAt}`).join(", ")
    );

    // TEST 10 (contract level) — item lookups stay scoped to their own row.
    const found = await findOrderRowInSheet(
      "testorder000000000000001",
      "testproduct000000000002",
      "testvariant000000000001",
      spreadsheetId
    );
    check("findOrderRowInSheet locates a variant row by orderId+productId+variantId", found?.sku === "TSH-RED-M");

    const missing = await findOrderRowInSheet(
      "testorder000000000000001",
      "testproduct000000000002",
      "someOtherVariant",
      spreadsheetId
    );
    check("findOrderRowInSheet returns null for a different variant", missing === null);
  } finally {
    await deleteSpreadsheet(spreadsheetId);
  }

  console.log(failures === 0 ? "\n✅ Orders sheet contract OK" : `\n❌ ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// Run only when executed directly — importing this file must have no side
// effects (it would create a spreadsheet in the caller's Drive).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error("❌ FAILED:", error?.response?.data?.error?.message || error.message);
    process.exit(1);
  });
}

export { main };
