import { Router } from "express";
import Store from "../../models/Store.js";
import { importProductsFromSheet } from "../../services/sheetSync.js";
import { syncSellerOrdersToSheet } from "../../services/sheetOrders.js";
import { syncInventoryToSheet } from "../../services/sheetInventory.js";
import { createOrdersSheet, getSheetTabs } from "../../services/googleSheetsServices.js";
import { SHEET_TABS, buildSheetTabUrl, spreadsheetUrlFor } from "../../services/sheetTabs.js";

const router = Router();

// This seller's store, auto-healing the seller.store reference the way the
// product/order routes do.
async function loadStore(req) {
  return (
    (req.seller.store
      ? await Store.findById(req.seller.store).select("_id name googleSheet").lean()
      : null) ||
    (await Store.findOne({ seller: req.seller._id }).select("_id name googleSheet").lean())
  );
}

// Which tabs the seller's spreadsheet has, plus ready-made deep links.
// `ordersUrl` opens the Orders tab specifically — the dashboard's "Open Orders
// Sheet" button uses it so it never lands on the Products tab.
router.get("/", async (req, res) => {
  const store = await loadStore(req);
  if (!store) return res.status(404).json({ success: false, message: "Store not found. Please create one." });

  const spreadsheetId = store.googleSheet?.spreadsheetId || "";
  const spreadsheetUrl =
    store.googleSheet?.spreadsheetUrl || spreadsheetUrlFor(spreadsheetId);

  // An expired token or a deleted sheet must not hide the link.
  let tabs = [];
  if (spreadsheetId) {
    try {
      tabs = await getSheetTabs(spreadsheetId);
    } catch (error) {
      console.error("⚠️ [Google Sheets] Could not list tabs:", error.message);
    }
  }

  const gidOf = (title) => tabs.find((tab) => tab.title === title)?.gid;

  res.json({
    success: true,
    data: {
      spreadsheetId,
      spreadsheetUrl,
      sharedWith: store.googleSheet?.sharedWith || "",
      tabs,
      ordersUrl: buildSheetTabUrl(spreadsheetUrl, gidOf(SHEET_TABS.orders)),
      inventoryUrl: buildSheetTabUrl(spreadsheetUrl, gidOf(SHEET_TABS.inventory)),
    },
  });
});

// "Sync now" — pull the seller's sheet edits into MongoDB (new rows, edited
// stock/price, with Phase 8 conflict handling), then refresh the derived tabs:
// the Orders tab is created if missing (or rebuilt if it was written by an older
// schema) and repopulated from this seller's recent orders, and the Inventory
// snapshot is rebuilt.
router.post("/sync", async (req, res) => {
  const store = await loadStore(req);

  if (!store?.googleSheet?.spreadsheetId) {
    return res.status(400).json({
      success: false,
      message:
        "Your store has no Google Sheet yet. Open your store page once to create one.",
    });
  }

  const data = await importProductsFromSheet({ seller: req.seller, store });

  // The Orders + Inventory tabs are best-effort: a Sheets outage must not lose
  // the product import above.
  let inventory = null;
  let orders = null;
  try {
    await createOrdersSheet(store.googleSheet.spreadsheetId);

    // Re-mirror recent orders, so a freshly created — or schema-rebuilt —
    // Orders tab shows the seller's order history instead of sitting empty.
    orders = await syncSellerOrdersToSheet(req.seller._id, store.googleSheet.spreadsheetId);

    inventory = await syncInventoryToSheet(store, { createIfMissing: true });
  } catch (error) {
    const message = error?.response?.data?.error?.message || error.message;
    console.error("⚠️ [Google Sheets] Tab refresh failed:", message);
  }

  res.json({
    success: true,
    message: "Google Sheets sync completed",
    data: { ...data, orders, inventory },
  });
});

// Rebuild the Inventory tab from MongoDB (created on first use)
router.post("/inventory", async (req, res) => {
  const store = await loadStore(req);

  if (!store?.googleSheet?.spreadsheetId) {
    return res.status(400).json({
      success: false,
      message:
        "Your store has no Google Sheet yet. Open your store page once to create one.",
    });
  }

  const inventory = await syncInventoryToSheet(store, { createIfMissing: true });

  if (!inventory) {
    return res.status(502).json({
      success: false,
      message: "Could not rebuild the Inventory tab. Please try again in a moment.",
    });
  }

  res.json({
    success: true,
    message: `Inventory updated (${inventory.rows} row${inventory.rows === 1 ? "" : "s"})`,
    data: inventory,
  });
});

export default router;
