import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ORDER_HEADERS, SHEET_TABS } from "./sheetTabs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.join(
  __dirname,
  "../credentials/google-credentials.json"
);

const TOKEN_PATH = path.join(
  __dirname,
  "../credentials/token.json"
);

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
];

function getOAuth2Client() {
  const credentials = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  const { client_secret, client_id, redirect_uris } =
    credentials.web || credentials.installed;

  return new google.auth.OAuth2(
    client_id,
    client_secret,
    process.env.GOOGLE_REDIRECT_URI || redirect_uris[0]
  );
}

export function getAuthorizationUrl() {
  const oauth2Client = getOAuth2Client();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
  });
}

export async function saveToken(code) {
  const oauth2Client = getOAuth2Client();

  const { tokens } = await oauth2Client.getToken(code);

  oauth2Client.setCredentials(tokens);

  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify(tokens, null, 2)
  );

  return tokens;
}

async function getAuthenticatedClient() {
  const oauth2Client = getOAuth2Client();

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error("Google OAuth authorization required.");
  }

  const token = JSON.parse(
    fs.readFileSync(TOKEN_PATH, "utf8")
  );

  oauth2Client.setCredentials(token);

  // Persist auto-refreshed access tokens. Without this the refreshed token only
  // lives in memory, so every request re-reads the stale token from disk and
  // refreshes again — and a revoked/expired refresh token then breaks Sheets
  // writes silently until someone re-runs the OAuth flow.
  oauth2Client.on("tokens", (tokens) => {
    try {
      const merged = { ...oauth2Client.credentials, ...tokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    } catch (err) {
      console.error("⚠️ [Google Sheets] Could not persist refreshed token:", err.message);
    }
  });

  return oauth2Client;
}

// ---------------------------------------------------------------------------
// Generic tab helpers
//
// A seller's spreadsheet holds several tabs (Products, Orders, Inventory) that
// are all mirrors of MongoDB. These helpers are tab-agnostic so every sync
// (services/sheetSync.js, sheetOrders.js, sheetInventory.js) shares them.
// ---------------------------------------------------------------------------

// 1 → "A", 27 → "AA" — headers are written as a range, not a single cell.
function columnLetter(index) {
  let letter = "";
  let remaining = index;

  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return letter;
}

// Every tab of a spreadsheet, with the numeric id (`gid`) that deep-links to it:
//   [{ title: "Orders", gid: 123456789 }, …]
// Pass an existing client to avoid authenticating twice in one call chain.
export async function getSheetTabs(spreadsheetId, client = null) {
  const auth = await getAuthenticatedClient();

  const sheets = client || google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title,sheets.properties.sheetId"
  });

  return (response.data.sheets || [])
    .map((sheet) => ({ title: sheet.properties?.title, gid: sheet.properties?.sheetId }))
    .filter((tab) => tab.title);
}

// Titles only, e.g. ["Products", "Orders"] — used to check whether a tab exists.
export async function getSheetTitles(spreadsheetId, client = null) {
  const tabs = await getSheetTabs(spreadsheetId, client);
  return tabs.map((tab) => tab.title);
}

/**
 * Make sure a tab exists and carries its header row.
 *
 * @param {string} spreadsheetId
 * @param {string} title tab name from services/sheetTabs.js
 * @param {string[]} headers header row to (re)write
 * @param {object} [options]
 * @param {boolean} [options.create=true] when false the tab is never created —
 *   used for optional tabs (Inventory) so a store that never opted in is left
 *   completely untouched.
 * @returns {Promise<{exists: boolean, created: boolean}>}
 */
export async function ensureSheetTab(spreadsheetId, title, headers = [], options = {}) {
  const { create = true } = options;

  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({ version: "v4", auth });

  const titles = await getSheetTitles(spreadsheetId, sheets);
  const existed = titles.includes(title);

  if (!existed) {
    if (!create) return { exists: false, created: false };

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
  }

  if (headers.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1:${columnLetter(headers.length)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  }

  return { exists: true, created: !existed };
}

// Raw values of a range, e.g. getSheetValues(id, "Orders!A:K").
export async function getSheetValues(spreadsheetId, range) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return response.data.values || [];
}

// Append rows under the last row of a tab.
export async function appendSheetValues(spreadsheetId, range, values) {
  if (!values || values.length === 0) return null;

  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return response.data;
}

// Overwrite a range with the given rows.
export async function updateSheetValues(spreadsheetId, range, values) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  return response.data;
}

// Overwrite a single row of a tab (used to update an order the app already wrote).
export async function updateSheetRow(spreadsheetId, sheetTitle, rowNumber, values) {
  return updateSheetValues(spreadsheetId, `${sheetTitle}!A${rowNumber}`, [values]);
}

// Empty a range without deleting its rows (keeps the tab's formatting intact).
export async function clearSheetValues(spreadsheetId, range) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range,
  });

  return response.data;
}

// ---------------------------------------------------------------------------
// Orders tab
//
// One seller spreadsheet, one tab per concern: Products (two-way product sync)
// and Orders (this section — an append/update mirror of the seller's order
// items). Row building and the seller/store → spreadsheet decision live in
// services/sheetOrders.js; these functions only talk to Sheets.
// ---------------------------------------------------------------------------

const ORDERS_LAST_COLUMN = columnLetter(ORDER_HEADERS.length);

const ORDERS_RANGE = `${SHEET_TABS.orders}!A:${ORDERS_LAST_COLUMN}`;
const ORDERS_HEADER_RANGE = `${SHEET_TABS.orders}!A1:${ORDERS_LAST_COLUMN}1`;
const ORDERS_BODY_RANGE = `${SHEET_TABS.orders}!A2:${ORDERS_LAST_COLUMN}`;

// Map a row object to the tab's column order, filling missing values with "".
const rowToValues = (row) =>
  ORDER_HEADERS.map((header) => {
    const value = row?.[header];
    return value === undefined || value === null ? "" : value;
  });

/**
 * Make sure the Orders tab exists with the expected headers. Never creates a
 * second spreadsheet and never duplicates an existing tab.
 *
 * A tab written by an older schema (different headers) is reset: its body is
 * cleared and the header row rewritten, because rows that no longer line up
 * with the headers cannot be interpreted. The caller repopulates from MongoDB
 * (`POST /api/seller/sheets/sync`).
 *
 * @returns {Promise<{exists: boolean, created: boolean, reset: boolean}>}
 */
export async function createOrdersSheet(spreadsheetId) {
  const exists = (await getSheetTitles(spreadsheetId)).includes(SHEET_TABS.orders);

  if (!exists) {
    await ensureSheetTab(spreadsheetId, SHEET_TABS.orders, ORDER_HEADERS);
    return { exists: true, created: true, reset: false };
  }

  const headerRow = await getSheetValues(spreadsheetId, ORDERS_HEADER_RANGE);
  const current = (headerRow[0] || []).map((value) => String(value).trim());
  const matches =
    current.length === ORDER_HEADERS.length &&
    ORDER_HEADERS.every((header, index) => current[index] === header);

  if (matches) return { exists: true, created: false, reset: false };

  console.warn(
    `⚠️ [Google Sheets] Orders tab on ${spreadsheetId} had ${current.length} column(s) — rewriting it to the current ${ORDER_HEADERS.length}-column schema`
  );

  await clearSheetValues(spreadsheetId, ORDERS_BODY_RANGE);
  await updateSheetValues(spreadsheetId, ORDERS_HEADER_RANGE, [ORDER_HEADERS]);

  return { exists: true, created: false, reset: true };
}

// Read every row of the Orders tab as header-keyed objects (plus `sheetRow`).
export async function getOrdersFromSheet(spreadsheetId) {
  const rows = await getSheetValues(spreadsheetId, ORDERS_RANGE);
  if (rows.length <= 1) return [];

  const headers = rows[0];

  return rows.slice(1).map((row, index) => {
    const order = {};
    headers.forEach((header, i) => {
      order[header] = row[i] ?? "";
    });

    // Real Google Sheets row number (header is row 1).
    order.sheetRow = index + 2;
    return order;
  });
}

/**
 * Find one order item's row. Identity is orderId + productId + variantId, so
 * two variants of the same product in one order stay separate rows while a
 * repeated sync of the same item updates instead of appending.
 *
 * @returns {Promise<object|null>} the row object (with `sheetRow`) or null
 */
export async function findOrderRowInSheet(orderId, productId, variantId, spreadsheetId) {
  const rows = await getOrdersFromSheet(spreadsheetId);
  const key = [orderId, productId, variantId || ""].join("::");

  return (
    rows.find(
      (row) => [row.orderId, row.productId, row.variantId || ""].join("::") === key
    ) || null
  );
}

/**
 * Append new order-item rows (header-keyed objects). Creates the tab and its
 * headers first, so the very first order on a fresh spreadsheet works.
 */
export async function addOrderToSheet(rows, spreadsheetId) {
  const list = (rows || []).filter(Boolean);
  if (list.length === 0) return null;

  await createOrdersSheet(spreadsheetId);

  return appendSheetValues(spreadsheetId, ORDERS_RANGE, list.map(rowToValues));
}

/** Rewrite one existing row in place (status change, cancellation, refund). */
export async function updateOrderInSheet(rowNumber, row, spreadsheetId) {
  return updateSheetValues(
    spreadsheetId,
    `${SHEET_TABS.orders}!A${rowNumber}:${ORDERS_LAST_COLUMN}${rowNumber}`,
    [rowToValues(row)]
  );
}

export async function testSheetsConnection() {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({
    version: "v4",
    auth
  });

  const response = await sheets.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID
  });

  return response.data.properties.title;
}

export async function addProductToSheet(product, customSpreadsheetId) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({
    version: "v4",
    auth
  });

  const spreadsheetId = customSpreadsheetId || product.spreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;

  const values = [[
    product.productId || "",
    product.sellerId || "",
    product.productName || "",
    product.description || "",
    product.price ?? "",
    product.stock ?? 0,
    product.discountType || "None",
    product.discountValue ?? 0,
    product.category || "",
    Array.isArray(product.tags)
      ? product.tags.join(", ")
      : product.tags || "",
    Array.isArray(product.imageUrls)
      ? product.imageUrls.join(", ")
      : product.imageUrls || "",
    product.weight ?? "",
    product.shippingCost ?? "",
    product.freeShipping ? "true" : "false",
    product.hasVariants ? "true" : "false",
    typeof product.variants === "object"
      ? JSON.stringify(product.variants)
      : product.variants || "",
    product.status || "Available",
    product.createdAt || new Date().toISOString(),
    product.updatedAt || new Date().toISOString()
  ]];

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Products!A:S",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values
    }
  });

  return response.data;
}


export async function updateProductInSheet(product, customSpreadsheetId) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const spreadsheetId = customSpreadsheetId || product.spreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;

  // Find the row using productId
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Products!A:S",
  });

  const rows = response.data.values || [];

  const productId = product._id?.toString() || product.productId?.toString();

  // The `variants` column carries the real variants (per-variant stock) when the
  // caller supplies them. Older callers only pass the option templates, so fall
  // back to those rather than blanking the column.
  const variantsValue = product.variants ?? product.variantOptions ?? "";

  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 && row[0] === productId
  );

  if (rowIndex === -1) {
    throw new Error(
      `Product ${productId} not found in Google Sheets`
    );
  }

  const values = [[
    productId,
    product.seller?.toString() || product.sellerId || "",
    product.name || product.productName || "",
    product.description || "",
    product.price ?? "",
    product.stock ?? 0,

    product.discount?.type || "None",
    product.discount?.value ?? 0,

    product.category?.toString() || "",
    
    Array.isArray(product.tags)
      ? product.tags.join(", ")
      : "",

    Array.isArray(product.images)
      ? product.images.map(image => image.url).join(", ")
      : "",

    product.shipping?.weight ?? 0,
    product.shipping?.shippingCost ?? 0,
    product.shipping?.freeShipping ? "true" : "false",

    (product.hasVariants ?? Boolean(variantsValue && variantsValue.length)) ? "true" : "false",

    variantsValue ? JSON.stringify(variantsValue) : "",

    product.status || "",

    product.createdAt
      ? new Date(product.createdAt).toISOString()
      : "",

    product.updatedAt
      ? new Date(product.updatedAt).toISOString()
      : "",
  ]];

  await sheets.spreadsheets.values.update({
    spreadsheetId,

    range: `Products!A${rowIndex + 1}:S${rowIndex + 1}`,

    valueInputOption: "USER_ENTERED",

    requestBody: {
      values,
    },
  });

  return {
    row: rowIndex + 1,
    productId,
  };
}

//get the latest product from sheet
export async function getProductsFromSheet(customSpreadsheetId) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const spreadsheetId = customSpreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Products!A:S",
  });

  const rows = response.data.values || [];

  if (rows.length <= 1) {
    return [];
  }

  const headers = rows[0];

  return rows.slice(1).map((row, index) => {
    const product = {};

    headers.forEach((header, i) => {
      product[header] = row[i] ?? "";
    });

    // Actual Google Sheets row number
    product.sheetRow = index + 2;

    return product;
  });
}


//update the created product in googl sheets
export async function updateProductIdInSheet(sheetRow, productId, customSpreadsheetId) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const spreadsheetId = customSpreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Products!A${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[productId]],
    },
  });

  return {
    row: sheetRow,
    productId,
  };
}

//stamp the seller's id onto a row the seller typed into their own sheet
export async function updateSellerIdInSheet(sheetRow, sellerId, customSpreadsheetId) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const spreadsheetId = customSpreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Products!B${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[sellerId]],
    },
  });

  return {
    row: sheetRow,
    sellerId,
  };
}

//update desc
export async function updateProductDescriptionInSheet(
  sheetRow,
  description,
  customSpreadsheetId
) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const spreadsheetId = customSpreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Products!D${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[description]],
    },
  });

  return {
    row: sheetRow,
    description,
  };
}

// Give one specific seller edit access to their own spreadsheet.
// Permission is granted to their account email only — never "anyone with the link"
// — so seller A can never open seller B's sheet.
export async function shareSpreadsheetWithSeller(spreadsheetId, sellerEmail) {
  if (!spreadsheetId || !sellerEmail) return null;

  const auth = await getAuthenticatedClient();

  const drive = google.drive({
    version: "v3",
    auth,
  });

  const response = await drive.permissions.create({
    fileId: spreadsheetId,
    // Drive refuses to share with an address that has no Google account unless
    // the recipient is notified, and sellers sign up with all kinds of email
    // addresses — so this must stay on. It also tells the seller their sheet is
    // ready. Sharing happens once per store, so this is one email at most.
    sendNotificationEmail: true,
    requestBody: {
      role: "writer",
      type: "user",
      emailAddress: sellerEmail,
    },
  });

  console.log(
    `✅ [Google Sheets] Shared spreadsheet ${spreadsheetId} with ${sellerEmail} (writer)`
  );

  return response.data;
}

// Strip every permission from a store's spreadsheet except the owner's and the
// seller's current email. Used when the seller's account email changed: the new
// address gets access and any old/stale address keeps none.
// Returns the list of revoked recipients so the caller can report them.
export async function revokeSheetAccessExcept(spreadsheetId, keepEmail) {
  if (!spreadsheetId) return [];

  const auth = await getAuthenticatedClient();

  const drive = google.drive({
    version: "v3",
    auth,
  });

  const { data } = await drive.permissions.list({
    fileId: spreadsheetId,
    fields: "permissions(id,type,role,emailAddress)",
  });

  const keep = String(keepEmail || "").toLowerCase();

  const stale = (data.permissions || []).filter(
    (permission) =>
      permission.role !== "owner" &&
      String(permission.emailAddress || "").toLowerCase() !== keep
  );

  const revoked = [];

  for (const permission of stale) {
    try {
      await drive.permissions.delete({
        fileId: spreadsheetId,
        permissionId: permission.id,
      });
      revoked.push(permission.emailAddress || permission.type);
    } catch (error) {
      const message = error?.response?.data?.error?.message || error.message;
      console.error(
        `⚠️ [Google Sheets] Could not revoke ${permission.emailAddress || permission.type} on ${spreadsheetId}: ${message}`
      );
    }
  }

  if (revoked.length) {
    console.log(
      `✅ [Google Sheets] Revoked access on ${spreadsheetId} for: ${revoked.join(", ")}`
    );
  }

  return revoked;
}

// Delete a spreadsheet with the app's own credentials. Used by cleanup tooling
// and the verification scripts — no seller request path ever deletes a sheet.
export async function deleteSpreadsheet(spreadsheetId) {
  if (!spreadsheetId) return false;

  const auth = await getAuthenticatedClient();

  const drive = google.drive({ version: "v3", auth });

  await drive.files.delete({ fileId: spreadsheetId });

  console.log(`🗑️ [Google Sheets] Deleted spreadsheet ${spreadsheetId}`);
  return true;
}

//automatically creates the spreadsheet
export async function createSellerSpreadsheet(shopName, sellerEmail) {
  const auth = await getAuthenticatedClient();

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  try {
    const spreadsheet = await sheets.spreadsheets.create({
      requestBody: {
        properties: {
          title: `ShopSphere - ${shopName}`,
        },
        sheets: [
          {
            properties: {
              title: "Products",
            },
          },
        ],
      },
    });

    const spreadsheetId = spreadsheet.data.spreadsheetId;

    // Phase 9 — a new sheet already carries the tab the seller's orders will
    // land in, so checkout never has to create it mid-request.
    try {
      await ensureSheetTab(spreadsheetId, SHEET_TABS.orders, ORDER_HEADERS);
    } catch (ordersTabError) {
      console.error(
        `⚠️ [Google Sheets] Could not create the Orders tab on ${spreadsheetId}: ${ordersTabError.message}`
      );
    }

    // Add the same headers used by the existing ShopSphere system
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Products!A1:S1",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
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
        ]],
      },
    });

    console.log(
      `✅ [Google Sheets] Created spreadsheet "${shopName}": ${spreadsheetId}`
    );

    // Hand the sheet to the seller. Best-effort: if the email isn't a Google
    // account the share fails, but the store must still keep its spreadsheet.
    let sharedWith = "";
    if (sellerEmail) {
      try {
        await shareSpreadsheetWithSeller(spreadsheetId, sellerEmail);
        sharedWith = sellerEmail;
      } catch (shareError) {
        const message =
          shareError?.response?.data?.error?.message || shareError.message;
        console.error(
          `⚠️ [Google Sheets] Could not share "${shopName}" with ${sellerEmail}: ${message}`
        );
      }
    }

    return {
      spreadsheetId,
      spreadsheetUrl:
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      sharedWith,
    };
  } catch (error) {
    const errMessage = error?.response?.data?.error?.message || error.message;
    console.error(`❌ [Google Sheets] Failed to create spreadsheet for "${shopName}": ${errMessage}`);
    throw error;
  }
}

export async function testGoogleIdentity() {
  const auth = await getAuthenticatedClient();

  const oauth2 = google.oauth2({
    version: "v2",
    auth
  });

  const response = await oauth2.userinfo.get();

  console.log("Google account being used:");
  console.log("Email:", response.data.email);
  console.log("Name:", response.data.name);

  return response.data;
}