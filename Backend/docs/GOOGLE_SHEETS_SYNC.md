# Google Sheets Sync — Phases 8, 9 & 10

Every store owns its own spreadsheet (`Store.googleSheet.spreadsheetId`), created the
first time the seller opens their store page and shared with their account email. The
sheet is the seller's editing surface; **MongoDB is the transactional source of truth**
(orders, stock reservations, payments).

```
Spreadsheet: "ShopSphere — <store name>"
├── Products   ←→ MongoDB   (two-way: seller edits in, app changes out)
├── Orders      → Sheet     (one row per order item, per seller)
└── Inventory   → Sheet     (optional snapshot, rebuilt from MongoDB)
```

Tab names and column order live in one place — [`services/sheetTabs.js`](../services/sheetTabs.js) —
so every sync service writes the same contract. New columns go at the **end** of a header
list: rows are read back by header name, so appending is safe and inserting is not.

## Which direction syncs, and when

| Direction | Trigger | Code |
|---|---|---|
| MongoDB → Products tab | Checkout stock deduction | [`APIS/customer/orders.js`](../APIS/customer/orders.js) → `syncProductToSheet` |
| MongoDB → Products tab | Customer/seller cancellation (stock restored) | `APIS/customer/orders.js`, [`APIS/seller/orders.js`](../APIS/seller/orders.js) |
| MongoDB → Products tab | Product/variant create, edit, restock | [`APIS/seller/products.js`](../APIS/seller/products.js) |
| MongoDB → Products tab | Return received (stock restored) | [`APIS/seller/returns.js`](../APIS/seller/returns.js) |
| Sheet → MongoDB | Background job, every 5 min | `startSheetSync()` in [`services/sheetSync.js`](../services/sheetSync.js) |
| Sheet → MongoDB | `POST /api/seller/products/import-from-sheet` | manual "import" |
| Sheet → MongoDB | `POST /api/seller/sheets/sync` | manual "sync now" (also refreshes Orders/Inventory) |
| MongoDB → Orders tab | Checkout, cancel, status change, delivery start/accept/deliver | [`services/sheetOrders.js`](../services/sheetOrders.js) |
| MongoDB → Orders tab | Return requested / approved / rejected / shipped / received / refunded | [`APIS/customer/returns.js`](../APIS/customer/returns.js), [`APIS/seller/returns.js`](../APIS/seller/returns.js), [`APIS/delivery/routes.js`](../APIS/delivery/routes.js) |
| MongoDB → Inventory tab | `POST /api/seller/sheets/sync`, `POST /api/seller/sheets/inventory`, 5-min cycle (existing tabs only) | [`services/sheetInventory.js`](../services/sheetInventory.js) |

All Sheets writes are **best-effort**: they are awaited, but a Google outage is logged and
swallowed so it can never fail a checkout, a cancellation or a product edit.

> **Cadence and quota.** The background job runs every **5 minutes**. Each cycle costs one
> Sheets read per store, plus one tab lookup for stores that have an Inventory tab — so the
> cost grows with the number of stores. Slow it down with `SHEET_SYNC_INTERVAL_MS` (e.g.
> `1800000` for 30 min) if you approach the Sheets API quota, and note that in-flight
> purchases mirror into the sheet immediately regardless of the cadence.

---

## Phase 8 — Conflict handling

Stock and price live in two places and both sides can move. The rule:

| Situation | Winner | What happens |
|---|---|---|
| Only the sheet moved (seller typed a new value) | **Sheet** | The value is imported into MongoDB — the seller's edit is deliberate. |
| Only MongoDB moved (purchase, cancel, restock) | **MongoDB** | The sheet row is rewritten from MongoDB. |
| **Both moved** | **MongoDB** | The sheet edit is dropped, MongoDB's value is written back to the sheet, and the row is reported as a conflict. |
| No baseline recorded (legacy row) | **Sheet** | Original import behaviour — nothing changes for rows written before baselines existed. |
| Sheet cell blank / not a number | **MongoDB** | Nothing is imported. |

### Why MongoDB wins a true conflict

A seller editing the sheet is usually looking at a number that is already stale — their row
said `20` while a customer's purchase had moved the real stock to `18`. Applying `25` would
**resurrect sold inventory** (and the same bug in the other direction silently oversells).
Money has already changed hands in MongoDB, so the purchase wins and the sheet is corrected
to `18`. The seller sees the true number on the next refresh instead of a phantom.

### How a conflict is detected

`Product.sheetSync` stores the value both sides were last reconciled to:

```js
sheetSync: {
  stock: 20,          // last reconciled stock
  price: 1500,        // last reconciled price
  variants: {         // per-variant baselines, keyed by variant id
    "<variantId>": { stock: 6, price: 1500 }
  },
  syncedAt: Date,
}
```

A baseline is written whenever the app pushes a row to the sheet (`syncProductToSheet`), when
a sheet row is imported into MongoDB, and when a new product is appended to a sheet. Comparing
the three numbers (`sheet`, `mongo`, `baseline`) tells the importer whether the sheet, MongoDB,
or both have moved — the logic lives in [`services/sheetConflicts.js`](../services/sheetConflicts.js)
and is pure, so it is unit-tested without a database (`test/sheetSync.test.mjs`).

Worked example (baseline `20`):

```
baseline 20 · sheet 25 · mongo 18   → conflict, MongoDB wins, sheet corrected to 18
baseline 20 · sheet 25 · mongo 20   → seller restocked, MongoDB becomes 25
baseline 20 · sheet 20 · mongo 18   → stale mirror, sheet corrected to 18
```

Conflicts are visible in two places: the `conflicts` array of an import result
(`POST /api/seller/products/import-from-sheet`, `POST /api/seller/sheets/sync`), and a
`[SheetSync] … conflict on stock — MongoDB wins, sheet corrected` warning per cycle.

---

## Phase 9 — Orders tab

```
Customer places order
        ↓
   MongoDB (parent order + one sub-order per seller)
        ↓
Seller A → Sheet A "Orders" tab      Seller B → Sheet B "Orders" tab
```

| # | Column | Level | Source |
|---|---|---|---|
| A | `orderId` | order | `Order._id` |
| B | `sellerId` | order | `Order.seller` (the sheet's owner) |
| C | `customerId` | order | `Order.customer` |
| D | `customerName` | order | `User.name`, falling back to `shippingAddress.fullName` |
| E | `customerEmail` | order | `User.email` |
| F | `productId` | item | `item.product` |
| G | `productName` | item | `item.productName` (snapshot) |
| H | `variantId` | item | `item.variant` (`""` when there is none) |
| I | `variantLabel` | item | `item.variantLabel` (e.g. `Red / M`) |
| J | `sku` | item | `item.sku` |
| K | `quantity` | item | `item.quantity` |
| L | `unitPrice` | item | `item.price` (snapshot) |
| M | `discount` | item | `item.discount` (snapshot) |
| N | `shippingCost` | order | `Order.shippingCost` |
| O | `tax` | item | `item.tax` (snapshot) |
| P | `itemTotal` | item | `item.total` (snapshot) |
| Q | `orderTotal` | order | `Order.total` |
| R | `paymentStatus` | order | `Order.payment.status` |
| S | `orderStatus` | order | `Order.status` |
| T | `shippingAddress` | order | `shippingAddress` joined, with the phone appended |
| U | `orderDate` | order | `Order.createdAt` (ISO) |
| V | `updatedAt` | order | `Order.updatedAt` (ISO) |

- **One row per purchased item**, so a checkout with three products writes three rows — all
  sharing an `orderId` and a `sellerId`, so the seller can filter per product.
- A multi-vendor order is split by checkout into sub-orders and each sub-order is written to
  **its own seller's** spreadsheet — Seller A's items never appear in Seller B's sheet. The
  destination is always derived from the authenticated seller → their Store →
  `store.googleSheet.spreadsheetId`; a `sellerId`/`spreadsheetId` from a request body is ignored.
- **Row identity is `orderId + productId + variantId`**, and the write is idempotent: a retried
  checkout, a page refresh, a duplicate request or the 5-minute cycle updates the existing row
  instead of appending a duplicate. Two variants of the same product stay two rows.
- `orderStatus` / `paymentStatus` mirror MongoDB **verbatim** (`placed`, `packed`,
  `out_for_delivery`, `delivered`, `cancelled`, `return_shipped`, `refunded`, …) — the sheet
  never invents a transition, and MongoDB stays the source of truth.
- Item prices/totals come from the order's stored snapshots, never from the current Product
  document, so re-pricing a product later cannot rewrite order history.
- The tab is created with the spreadsheet (Products + Orders) and back-filled for older sheets by
  `POST /api/seller/sheets/sync`.
- A tab whose headers don't match the current schema (an older layout) is **reset** — body
  cleared, headers rewritten — and repopulated from the seller's recent orders the next time
  they run a sync, because rows that no longer line up with the headers can't be interpreted.
- `Order.googleSheetSyncStatus` (`pending` → `synced` / `failed`, plus `googleSheetSyncedAt` and
  `googleSheetSyncError`) tracks the mirror only — it never changes the business status, and the
  bookkeeping write deliberately doesn't bump the order's `updatedAt`.
- **The Orders view has an "Open Orders Sheet" button** that deep-links to this tab
  (`#gid=…`), so sellers land on Orders rather than the Products tab.

---

## Phase 10 — Inventory tab

Optional, opt-in view of current stock — created the first time a seller runs
`POST /api/seller/sheets/inventory` (or a "sync now"), never by the background job.

| productId | productName | sku | currentStock | reservedStock | availableStock | lowStockThreshold | lastUpdated |
|---|---|---|---|---|---|---|---|

- **One row per variant** (`sku`, `reservedStock`, `lowStockThreshold` are variant-level),
  and one row for products without variants (blank `sku`/threshold, `availableStock = stock`).
- `availableStock = currentStock − reservedStock`, clamped at 0.
- The tab is a **snapshot, not a ledger**: it is cleared and rebuilt from MongoDB on every
  sync, so rows for deleted products/variants disappear rather than lingering as stale numbers.

---

### Verifying the Orders tab live

```bash
cd Backend && node scripts/test-orders-sheet.js
```

Creates a throwaway spreadsheet and checks the real Sheets API: Products + Orders created,
headers exactly as above and in order, one row per purchased item, variant columns,
idempotent re-sync (no duplicate rows), in-place status update, and item lookup by
`orderId + productId + variantId`. The spreadsheet is deleted at the end.

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/seller/sheets` | Sheet link, every tab *with its gid*, and deep links (`ordersUrl`, `inventoryUrl`) that open a specific tab |
| POST | `/api/seller/sheets/sync` | "Sync now": import sheet edits (Phase 8 rules) + refresh Orders/Inventory |
| POST | `/api/seller/sheets/inventory` | Rebuild the Inventory tab (creates it on first use) |
| POST | `/api/seller/products/import-from-sheet` | Products-only import (same importer as the 5-min job) |
| POST | `/api/seller/store/sheet/reshare` | Re-share/repair access to the seller's spreadsheet |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_SPREADSHEET_ID` | — | Platform-wide fallback sheet (stores get their own) |
| `GOOGLE_REDIRECT_URI` | first value in the credentials file | OAuth callback used to install the Sheets/Drive token |
| `SHEET_SYNC_ENABLED` | `true` | Set `false` to disable the background job |
| `SHEET_SYNC_INTERVAL_MS` | `300000` (5 min) | Background sync cadence |
| `SHEET_SYNC_RUN_ON_START` | `true` | Run one cycle at boot (catches rows added while the server was down) |

## Returns and refunds

Return flows touch both tabs, so every transition mirrors what MongoDB now knows:

| Step | Order status | Sheet effect |
|---|---|---|
| Customer requests a return | `return_requested` | Orders tab `orderStatus` updated |
| Seller approves | `return_approved` | Orders tab updated |
| Seller rejects / customer withdraws | back to `delivered` | Orders tab updated |
| Customer ships the item back | `return_shipped` | Orders tab updated |
| Delivery partner picks it up | `return_shipped` | Orders tab updated |
| Seller receives it | `return_received`, `paymentStatus: refunded` | **Stock restored** → Products tab rewritten for each returned product, then the Orders tab |

Stock is only restored on receipt (the item is physically back), and the product mirror runs
through `syncProductToSheet`, so the reconciliation baseline moves with it and the next import
cannot mistake the restored stock for a sheet edit.

## Not covered (yet)

- **Deleting a row** from a sheet does not delete the product; products are soft-deleted from
  the app only.
- **Payment verification** (`POST /api/customer/payments/verify`) marks sub-orders paid without
  touching the Orders tab, so its `paymentStatus` column only follows COD/delivery and refunds.
- The Inventory tab is rebuilt per store; very large catalogues will make that call heavy.
