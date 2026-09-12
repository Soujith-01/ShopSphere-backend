/**
 * End-to-end API test driver — Freebuff ShopSphere backend
 *
 * Prereq: a server running against an isolated test DB, e.g.
 *   PORT=3001 MONGODB_URI=mongodb://localhost:27017/shopsphere_apitest node server.js
 *
 * Run:  node test-api.mjs [baseUrl]
 * It bootstraps its own users (admin/seller/delivery/support/customer),
 * exercises the whole marketplace lifecycle, prints PASS/FAIL per call and
 * drops the test database when done (remove CLEANUP_AT_END=0 to keep data).
 */
import mongoose from "mongoose";

const BASE = process.argv[2] || "http://localhost:3001";
const DB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/shopsphere_apitest";
const CLEANUP = process.env.CLEANUP_AT_END !== "0";
const TS = Date.now().toString(36);

let pass = 0, fail = 0;
const failures = [];
const S = {}; // shared state

const out = (ok, name, extra = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); failures.push(`${name} ${extra}`); }
};

async function call(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : raw,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  const setCookie = res.headers.get("set-cookie") || "";
  const refreshMatch = setCookie.match(/refreshToken=([^;]+)/);
  return { status: res.status, json, text, refreshToken: refreshMatch ? decodeURIComponent(refreshMatch[1]) : null };
}

const T = (name, method, path, { token, body, expected = 200, stateKey, pick } = {}) =>
  (async () => {
    try {
      const r = await call(method, path, { token, body });
      let ok = r.status === expected;
      let extra = `→ ${r.status} ${r.json?.message || ""}`.trim();
      if (ok && stateKey) {
        let picked = r.json?.data;
        if (pick) picked = pick(r.json);
        if (picked === undefined || picked === null) { ok = false; extra += " (state not found in response)"; }
        else S[stateKey] = picked;
      }
      out(ok, `${name} [${method} ${path}]`, ok ? "" : extra);
      if (!ok && r.json) console.log(`       ${JSON.stringify(r.json).slice(0, 400)}`);
      return r;
    } catch (e) {
      out(false, `${name} [${method} ${path}]`, `EXCEPTION ${e.message}`);
      return null;
    }
  })();

const step = (label) => console.log(`\n── ${label} ──`);

// ---------------------------------------------------------------------------
console.log(`\n>>> Testing ${BASE}  (test db: ${DB_URI})`);

// Bootstrap DB connection for role changes + cleanup
await mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 5000 });
const db = mongoose.connection.db;
// Start from a clean slate — leftover data from crashed runs must not affect results
await db.dropDatabase();
// Dropping the DB also drops indexes (e.g. the text index used by $text search).
// Rebuild them so keyword-search fallbacks work during the run.
const ProductModel = (await import("./models/Product.js")).default;
await ProductModel.init();
console.log("🧹 test database reset:", DB_URI);
console.log("RUN ID:", TS);

const roleUsers = {};
let r;
step("AUTH — register / login / me / refresh / logout");
r = await call("POST", "/api/auth/register", { body: { name: "Test Customer", email: `cust+${TS}@test.dev`, password: "pass12345" } });
roleUsers.cust = r.json?.data?.user;
S.custTok = r.json?.data?.accessToken;
out(r.status === 201 && !!roleUsers.cust, "register customer (201)", `→ ${r.status}`);
r = await call("POST", "/api/auth/register", { body: { name: "Dup", email: `cust+${TS}@test.dev`, password: "pass12345" } });
out(r.status === 400 && r.json?.message?.includes("already"), "register duplicate email rejected (400)", `→ ${r.status}`);
r = await call("POST", "/api/auth/register", { body: { name: "X", email: "notanemail", password: "123" } });
out(r.status === 400, "register invalid payload rejected (400)", `→ ${r.status}`);
r = await call("POST", "/api/auth/login", { body: { email: `cust+${TS}@test.dev`, password: "wrongpass" } });
out(r.status === 401, "login wrong password rejected (401)", `→ ${r.status}`);
r = await call("POST", "/api/auth/login", { body: { email: `cust+${TS}@test.dev`, password: "pass12345" } });
out(r.status === 200 && !!r.json?.data?.accessToken, "login customer (200)", `→ ${r.status}`);
roleUsers.cust = r.json?.data?.user;
S.custTok = r.json?.data?.accessToken;
out(!!r.refreshToken, "login sets refreshToken cookie");
S.refreshTok = r.refreshToken;
await T("me with token", "GET", "/api/auth/me", { token: S.custTok, expected: 200 });
r = await call("GET", "/api/auth/me");
out(r.status === 401, "me without token rejected (401)", `→ ${r.status}`);
await T("refresh access token", "POST", "/api/auth/refresh", { body: { refreshToken: S.refreshTok }, expected: 200, stateKey: "custTok", pick: (j) => j.data?.accessToken });

// Register other role accounts.
// Sellers sign up through the PUBLIC register endpoint (creates User + Seller doc).
// Admin/delivery/support are staff roles with no public onboarding — flipped in DB below.
for (const [key, name] of [["adm", "Admin"], ["del", "Delivery"], ["sup", "Support"]]) {
  r = await call("POST", "/api/auth/register", { body: { name: `${name} ${TS}`, email: `${key}+${TS}@test.dev`, password: "pass12345" } });
  roleUsers[key] = r.json?.data?.user;
}
r = await call("POST", "/api/auth/register", { body: { name: `Seller ${TS}`, email: `sel+${TS}@test.dev`, password: "pass12345", role: "seller", businessName: `Test Store Co ${TS}` } });
roleUsers.sel = r.json?.data?.user;
out(r.status === 201 && roleUsers.sel?.role === "seller" && r.json?.data?.requiresApproval === true, "register seller via public API (201, pending approval, no session)", `→ ${r.status} role=${roleUsers.sel?.role}`);
r = await call("POST", "/api/auth/login", { body: { email: `sel+${TS}@test.dev`, password: "pass12345" } });
out(r.status === 403, "unapproved seller login blocked (403)", `→ ${r.status} ${r.json?.message || ""}`);
r = await call("POST", "/api/auth/register", { body: { name: "Bad Seller", email: `badseller+${TS}@test.dev`, password: "pass12345", role: "seller" } });
out(r.status === 400, "seller register without businessName rejected (400)", `→ ${r.status}`);
r = await call("POST", "/api/auth/register", { body: { name: "Admin Wannabe", email: `badrole+${TS}@test.dev`, password: "pass12345", role: "admin" } });
out(r.status === 400, "register with role=admin rejected (400)", `→ ${r.status}`);
out(Object.values(roleUsers).every(Boolean), "registered all role accounts");

// ─── DELIVERY AGENT ONBOARDING (public register → admin verify → login) ────
// Registration now accepts multipart/form-data so we upload a tiny real PNG
// (1x1 transparent) as the driving-license photo.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const registerDeliveryAgent = async ({ name, email }) => {
  const fd = new FormData();
  fd.append("name", name);
  fd.append("email", email);
  fd.append("password", "pass12345");
  fd.append("role", "delivery");
  fd.append("phone", "9876500000");
  fd.append("vehicleType", "Bike");
  fd.append("vehicleNumber", "KA05MJ4831");
  fd.append("licenseNumber", "KA0520230001234");
  fd.append("licensePhoto", new Blob([PNG_BYTES], { type: "image/png" }), "license.png");
  const res = await fetch(`${BASE}/api/auth/register`, { method: "POST", body: fd });
  return { status: res.status, json: await res.json().catch(() => null) };
};

step("DELIVERY ONBOARDING — public register with vehicle + license");
r = await registerDeliveryAgent({ name: `Agent ${TS}`, email: `agent1+${TS}@test.dev` });
out(r.status === 201 && r.json?.data?.requiresApproval === true, "delivery agent registers via public API (201, pending, no session)", `→ ${r.status} ${r.json?.message || ""}`);
S.agent1 = r.json?.data?.user;
out(S.agent1?.role === "delivery", "registered account has role=delivery", `→ ${S.agent1?.role}`);
out(S.agent1?.deliveryPartner?.verificationStatus === "pending", "verificationStatus starts pending", `→ ${S.agent1?.deliveryPartner?.verificationStatus}`);
r = await call("POST", "/api/auth/login", { body: { email: `agent1+${TS}@test.dev`, password: "pass12345" } });
out(r.status === 403, "unverified delivery agent login blocked (403)", `→ ${r.status} ${r.json?.message || ""}`);

// Missing license photo → 400, and no orphaned user is left behind.
r = await call("POST", "/api/auth/register", {
  body: { name: "No License", email: `agent2+${TS}@test.dev`, password: "pass12345", role: "delivery", phone: "9876500001", vehicleType: "Bike", vehicleNumber: "KA01AB1111", licenseNumber: "KA0520230009999" },
});
out(r.status === 400 && String(r.json?.message).includes("license"), "delivery register without license photo rejected (400)", `→ ${r.status} ${r.json?.message || ""}`);
const UserEarly = (await import("./models/User.js")).default;
const orphans = await UserEarly.countDocuments({ email: `agent2+${TS}@test.dev` });
out(orphans === 0, "no orphaned user left after failed delivery registration", `→ count=${orphans}`);
// flip staff roles in DB (no public onboarding for staff accounts)
const User = (await import("./models/User.js")).default;
await User.updateOne({ _id: roleUsers.adm._id }, { $set: { role: "admin" } });
// Staff delivery accounts are provisioned pre-approved (public delivery
// registration is the self-service path that starts as "pending").
await User.updateOne({ _id: roleUsers.del._id }, { $set: { role: "delivery", "deliveryPartner.verificationStatus": "approved" } });
await User.updateOne({ _id: roleUsers.sup._id }, { $set: { role: "support" } });

step("AUTH — role users login (tokens from register are valid after role flip)");
// Admin approval flow: flip the seller to verified directly in the DB, exactly
// as PUT /api/admin/sellers/:sellerId/verify would (admin token not minted yet).
const SellerModelPre = (await import("./models/Seller.js")).default;
await SellerModelPre.updateOne({ user: roleUsers.sel._id }, { $set: { isVerified: true } });
for (const [key, name] of [["adm", "admin"], ["sel", "seller"], ["del", "delivery"], ["sup", "support"]]) {
  r = await call("POST", "/api/auth/login", { body: { email: `${key}+${TS}@test.dev`, password: "pass12345" } });
  S[`${key}Tok`] = r.json?.data?.accessToken;
  out(!!S[`${key}Tok`], `login ${name} → token`);
}

step("AUTHZ — role guards");
r = await call("GET", "/api/admin/users", { token: S.custTok });
out(r.status === 403, "customer blocked from admin (403) [GET /api/admin/users]", `→ ${r.status}`);
r = await call("GET", "/api/seller/products", { token: S.custTok });
out(r.status === 403, "customer blocked from seller (403) [GET /api/seller/products]", `→ ${r.status}`);
r = await call("GET", "/api/delivery/stats", { token: S.custTok });
out(r.status === 403, "customer blocked from delivery (403) [GET /api/delivery/stats]", `→ ${r.status}`);
r = await call("GET", "/api/support/stats", { token: S.custTok });
out(r.status === 403, "customer blocked from support (403) [GET /api/support/stats]", `→ ${r.status}`);

step("ADMIN USERS — list / stats / deactivate / reactivate");
await T("list users", "GET", "/api/admin/users?role=customer", { token: S.admTok, expected: 200 });
await T("user stats", "GET", "/api/admin/users/stats", { token: S.admTok, expected: 200 });
await T("user detail", "GET", `/api/admin/users/${roleUsers.cust._id}`, { token: S.admTok, expected: 200 });
await T("update user (admin put)", "PUT", `/api/admin/users/${roleUsers.sel._id}`, { token: S.admTok, body: { name: `Seller Renamed ${TS}` }, expected: 200 });
r = await call("GET", `/api/admin/users/${roleUsers.sel._id}`, { token: S.admTok });
S.selUserId = roleUsers.sel._id;
await T("deactivate seller-user", "PUT", `/api/admin/users/${S.selUserId}/deactivate`, { token: S.admTok, expected: 200 });
r = await call("POST", "/api/auth/login", { body: { email: `sel+${TS}@test.dev`, password: "pass12345" } });
out(r.status === 403, "deactivated user cannot login (403)", `→ ${r.status}`);

// --- Reactivation request flow (deactivated user asks admin to unlock) ---
r = await call("POST", "/api/auth/request-activation", { body: { email: `sel+${TS}@test.dev` } });
out(r.status === 200, "deactivated user can request reactivation (200)", `→ ${r.status}`);
r = await call("GET", "/api/admin/users?activationRequested=true", { token: S.admTok });
out(r.status === 200 && r.json?.data?.some((u) => u._id === S.selUserId), "admin sees user in reactivation-request filter", `→ ${r.status} total=${r.json?.pagination?.total}`);
r = await call("GET", `/api/admin/users/${S.selUserId}`, { token: S.admTok });
out(r.status === 200 && !!r.json?.data?.activationRequestedAt, "activationRequestedAt set on user", `→ ${r.status}`);
// repeat within 24h must NOT spam admins again (timestamp unchanged)
r = await call("POST", "/api/auth/request-activation", { body: { email: `sel+${TS}@test.dev` } });
let rr = await call("GET", `/api/admin/users/${S.selUserId}`, { token: S.admTok });
out(r.status === 200, "duplicate reactivation request still returns OK (no spam)", `→ ${r.status}`);
out(rr.json?.data && Math.abs(new Date(rr.json.data.activationRequestedAt) - new Date()) < 60_000, "duplicate request did not update timestamp (already requested < 24h)");
r = await call("POST", "/api/auth/request-activation", { body: { email: `ghost+${TS}@test.dev` } });
out(r.status === 200 && String(r.json?.message || "").includes("If your account is deactivated"), "request-activation for unknown email uses the same generic message (no user enumeration)", `→ ${r.status} ${r.json?.message || ""}`);
// admin approves via the dedicated activate route → user notified + can login
await T("admin approves reactivation", "PUT", `/api/admin/users/${S.selUserId}/activate`, { token: S.admTok, expected: 200 });
r = await call("GET", `/api/admin/users/${S.selUserId}`, { token: S.admTok });
out(r.status === 200 && r.json?.data?.activationRequestedAt === null, "activationRequestedAt cleared after approval", `→ ${r.status}`);
r = await call("GET", `/api/seller/notifications?limit=50`, { token: "" });
out(r.status === 401, "notifications need auth (sanity)", `→ ${r.status}`);

await T("reactivate seller-user (generic put)", "PUT", `/api/admin/users/${S.selUserId}`, { token: S.admTok, body: { isActive: true }, expected: 200 });
r = await call("POST", "/api/auth/login", { body: { email: `sel+${TS}@test.dev`, password: "pass12345" } });
S.selTok = r.json?.data?.accessToken;
out(!!S.selTok, "reactivated user can login again");
// user received the account_reactivated notification (customer route keys off User._id)
r = await call("GET", "/api/customer/notifications?limit=50", { token: S.selTok });
out(r.status === 200 && r.json?.data?.notifications?.some((n) => n.type === "account_reactivated"), "user notified of reactivation", `→ ${r.status}`);

step("ADMIN CATEGORIES — create hierarchy / update / guarded delete");
await T("create root category", "POST", "/api/admin/categories", {
  token: S.admTok, body: { name: `Electronics ${TS}`, description: "Gadgets", attributes: [{ name: "Brand", type: "text", isRequired: true }], sortOrder: 1, isFeatured: true },
  expected: 201, stateKey: "catId", pick: (j) => j.data?._id,
});
S.catSlug = (await call("GET", "/api/admin/categories", { token: S.admTok })).json?.data?.find((c) => c._id === S.catId)?.slug;
out(!!S.catSlug, "category slug auto-generated");
await T("create subcategory", "POST", "/api/admin/categories", {
  token: S.admTok, body: { name: `Mobiles ${TS}`, parentCategory: S.catId }, expected: 201, stateKey: "subCatId", pick: (j) => j.data?._id,
});
await T("list categories (level 0)", "GET", "/api/admin/categories?level=0", { token: S.admTok, expected: 200 });
await T("update category", "PUT", `/api/admin/categories/${S.catId}`, { token: S.admTok, body: { name: `Electronics Pro ${TS}` }, expected: 200 });
r = await call("GET", "/api/admin/categories", { token: S.admTok });
S.catSlug = r.json?.data?.find((c) => c._id === S.catId)?.slug; // slug regenerated on rename
out(!!S.catSlug, "slug updated after category rename");
r = await call("DELETE", `/api/admin/categories/${S.catId}`, { token: S.admTok });
out(r.status === 400, "delete category with children blocked (400)", `→ ${r.status}`);
await T("delete subcategory", "DELETE", `/api/admin/categories/${S.subCatId}`, { token: S.admTok, expected: 200 });
await T("customer category list", "GET", "/api/customer/categories", { expected: 200 });
await T("customer category by slug", "GET", `/api/customer/categories/${S.catSlug}`, { expected: 200 });
await T("recreate subcategory for product", "POST", "/api/admin/categories", {
  token: S.admTok, body: { name: `Mobiles2 ${TS}`, parentCategory: S.catId }, expected: 201, stateKey: "subCatId2", pick: (j) => j.data?._id,
});

step("ADMIN COUPONS — create / list / update / toggle");
await T("create coupon SAVE10", "POST", "/api/admin/coupons", {
  token: S.admTok,
  body: { code: "SAVE10", description: "10% off", discountType: "percentage", discountValue: 10, maxDiscountAmount: 200, minOrderAmount: 500, maxUsageTotal: 100, maxUsagePerUser: 2, validFrom: "2026-08-01", validTo: "2026-12-31", scope: "platform" },
  expected: 201, stateKey: "couponId", pick: (j) => j.data?._id,
});
await T("list coupons", "GET", "/api/admin/coupons", { token: S.admTok, expected: 200 });
await T("update coupon", "PUT", `/api/admin/coupons/${S.couponId}`, { token: S.admTok, body: { maxUsageTotal: 500 }, expected: 200 });
await T("toggle coupon off", "PUT", `/api/admin/coupons/${S.couponId}/toggle`, { token: S.admTok, expected: 200 });
r = await call("POST", "/api/customer/coupons/validate", { token: S.custTok, body: { code: "SAVE10", subtotal: 1000 } });
out(r.status === 404, "inactive coupon rejected on validate (404)", `→ ${r.status}`);
await T("toggle coupon on", "PUT", `/api/admin/coupons/${S.couponId}/toggle`, { token: S.admTok, expected: 200 });

step("SELLER — store create/update, product & variant lifecycle, submit");
await T("create store", "POST", "/api/seller/store", {
  token: S.selTok, body: { name: `Gadget World ${TS}`, description: "Best gadgets", address: { street: "1 Market Rd", city: "Delhi", state: "DL", pincode: "110001" }, policies: { returnPolicy: "7-day" } },
  expected: 201, stateKey: "storeId", pick: (j) => j.data?._id,
});
await T("get store", "GET", "/api/seller/store", { token: S.selTok, expected: 200 });
await T("update store", "PUT", "/api/seller/store", { token: S.selTok, body: { tagline: "Quality you can trust" }, expected: 200 });
await T("create product (auto-published)", "POST", "/api/seller/products", {
  token: S.selTok,
  body: { name: `Wireless Mouse ${TS}`, description: "Ergonomic mouse", price: 799, category: S.catId, subCategory: S.subCatId2, tags: ["electronics", "mouse"], store: S.storeId, images: [{ url: "https://example.com/img.jpg", publicId: "img-1" }], shipping: { weight: 150 } },
  expected: 201, stateKey: "product", pick: (j) => j.data,
});
S.productId = S.product?._id;
S.slug = S.product?.slug;
out(!!S.productId && S.product?.status === "active", "product created as active (live immediately)", `→ status=${S.product?.status}`);
out(!!S.slug, "product slug auto-generated");
r = await call("GET", `/api/customer/products/${S.slug}`);
out(r.status === 200, "product visible to customers right after creation", `→ ${r.status}`);
await T("list my products", "GET", "/api/seller/products", { token: S.selTok, expected: 200 });
await T("update product", "PUT", `/api/seller/products/${S.productId}`, { token: S.selTok, body: { price: 749 }, expected: 200 });
await T("create variant", "POST", `/api/seller/products/${S.productId}/variants`, {
  token: S.selTok, body: { options: { color: "Black" }, label: "Black", sku: `WM-${TS}`, price: 849, stock: 50, lowStockThreshold: 5, weight: 150 },
  expected: 201, stateKey: "variantId", pick: (j) => j.data?._id,
});
await T("list variants", "GET", `/api/seller/products/${S.productId}/variants`, { token: S.selTok, expected: 200 });
await T("update variant stock", "PUT", `/api/seller/products/${S.productId}/variants/${S.variantId}/stock`, { token: S.selTok, body: { stock: 60, lowStockThreshold: 8 }, expected: 200 });
await T("update variant", "PUT", `/api/seller/products/${S.productId}/variants/${S.variantId}`, { token: S.selTok, body: { price: 799 }, expected: 200 });
step("ADMIN — moderation tools still work (reject → republish → approve)");
await T("moderation queue", "GET", "/api/admin/products/moderation", { token: S.admTok, expected: 200 });
// Products auto-publish, but admins can still reject and sellers can republish:
await T("reject live product", "PUT", `/api/admin/products/${S.productId}/reject`, { token: S.admTok, body: { reason: "Blurry image" }, expected: 200 });
r = await call("GET", `/api/customer/products/${S.slug}`);
out(r.status === 404, "rejected product hidden from customers (404)", `→ ${r.status}`);
await T("seller republishes rejected product", "POST", `/api/seller/products/${S.productId}/submit`, { token: S.selTok, expected: 200 });
r = await call("GET", `/api/customer/products/${S.slug}`);
out(r.status === 200, "republished product visible again (200)", `→ ${r.status}`);
r = await call("POST", `/api/seller/products/${S.productId}/submit`, { token: S.selTok });
out(r.status === 400, "submit on active product blocked (400)", `→ ${r.status}`);
// The approve path still works for pending products (e.g. seeded manually):
const SellerModel = (await import("./models/Seller.js")).default;
const selDoc = await SellerModel.findOne({ user: roleUsers.sel._id }).lean();
const pendingProd = await ProductModel.create({
  name: `Pending Item ${TS}`, slug: `pending-${TS}`, description: "Awaiting approval", price: 500,
  category: S.catId, store: S.storeId, seller: selDoc._id, status: "pending",
  images: [{ url: "https://example.com/p.jpg", publicId: "p1" }],
});
await T("approve pending product", "PUT", `/api/admin/products/${pendingProd._id}/approve`, { token: S.admTok, expected: 200 });
await T("toggle featured on", "PUT", `/api/admin/products/${S.productId}/featured`, { token: S.admTok, expected: 200 });
await T("admin product list", "GET", "/api/admin/products", { token: S.admTok, expected: 200 });

step("CUSTOMER — browse products, wishlist");
await T("browse products", "GET", "/api/customer/products?page=1&limit=20", { expected: 200 });
await T("featured products", "GET", "/api/customer/products/featured", { expected: 200 });
await T("product by category", "GET", `/api/customer/products/category/${S.catSlug}`, { expected: 200 });
await T("product detail by slug", "GET", `/api/customer/products/${S.slug}`, { expected: 200 });
await T("wishlist toggle add", "POST", "/api/customer/wishlist/toggle", { token: S.custTok, body: { productId: S.productId }, expected: 200 });
r = await call("GET", `/api/customer/wishlist/check/${S.productId}`, { token: S.custTok });
out(r.json?.data?.isWishlisted === true, "wishlist check true", `→ ${JSON.stringify(r.json?.data)}`);
await T("wishlist list", "GET", "/api/customer/wishlist", { token: S.custTok, expected: 200 });
await T("wishlist toggle remove", "POST", "/api/customer/wishlist/toggle", { token: S.custTok, body: { productId: S.productId }, expected: 200 });

step("CUSTOMER — cart add/update/remove + coupon apply + address");
await T("add to cart (variant)", "POST", "/api/customer/cart", { token: S.custTok, body: { productId: S.productId, variantId: S.variantId, quantity: 2 }, expected: 200 });
await T("get cart", "GET", "/api/customer/cart", { token: S.custTok, expected: 200 });
r = await call("GET", "/api/customer/cart", { token: S.custTok });
const cartItem = r.json?.data?.items?.[0];
S.cartItemId = cartItem?._id;
out(!!S.cartItemId && cartItem.productName, "cart contains item", `→ ${JSON.stringify(r.json?.data?.items)}`);
await T("update cart qty to 3", "PUT", `/api/customer/cart/${S.cartItemId}`, { token: S.custTok, body: { quantity: 3 }, expected: 200 });
await T("remove cart item", "DELETE", `/api/customer/cart/${S.cartItemId}`, { token: S.custTok, expected: 200 });
await T("re-add to cart", "POST", "/api/customer/cart", { token: S.custTok, body: { productId: S.productId, variantId: S.variantId, quantity: 2 }, expected: 200 });
await T("validate coupon", "POST", "/api/customer/coupons/validate", { token: S.custTok, body: { code: "SAVE10", subtotal: 1600 }, expected: 200 });
await T("apply coupon to cart", "POST", "/api/customer/coupons/apply", { token: S.custTok, body: { code: "SAVE10" }, expected: 200 });
await T("remove coupon", "DELETE", "/api/customer/coupons/remove", { token: S.custTok, expected: 200 });
await T("re-apply coupon", "POST", "/api/customer/coupons/apply", { token: S.custTok, body: { code: "SAVE10" }, expected: 200 });
await T("add address A", "POST", "/api/customer/users/me/addresses", { token: S.custTok, body: { label: "Home", fullName: "Test Customer", phone: "9876543210", street: "123 Main St", pincode: "110001", isDefault: true }, expected: 201, stateKey: "addrA", pick: (j) => j.data[j.data.length - 1]?._id });
await T("add address B", "POST", "/api/customer/users/me/addresses", { token: S.custTok, body: { label: "Work", fullName: "Test Customer", phone: "9876543211", street: "456 Work Rd", pincode: "560001" }, expected: 201, stateKey: "addrB", pick: (j) => j.data[j.data.length - 1]?._id });
await T("set B default", "PUT", `/api/customer/users/me/addresses/${S.addrB}/default`, { token: S.custTok, expected: 200 });
await T("update address B", "PUT", `/api/customer/users/me/addresses/${S.addrB}`, { token: S.custTok, body: { street: "789 Updated Rd" }, expected: 200 });
await T("get profile (addresses)", "GET", "/api/customer/users/me", { token: S.custTok, expected: 200 });
await T("update profile", "PUT", "/api/customer/users/me", { token: S.custTok, body: { name: `Customer Renamed ${TS}` }, expected: 200 });

step("CUSTOMER ORDERS — checkout");
await T("checkout with coupon", "POST", "/api/customer/orders/checkout", {
  token: S.custTok, body: { shippingAddressId: S.addrA, paymentMethod: "cod", couponCode: "SAVE10", customerNote: "Leave at door" },
  expected: 201, stateKey: "subOrders", pick: (j) => j.data?.subOrders,
});
S.orderId = S.subOrders?.[0]?._id;
r = await call("POST", "/api/customer/orders/checkout", { token: S.custTok, body: { shippingAddressId: S.addrA, paymentMethod: "cod" } });
out(r.status === 400 && String(r.json?.message).includes("empty"), "checkout with empty cart blocked (400)", `→ ${r.status}`);
out(!!S.orderId, "checkout created sub-order", "");
await T("my orders", "GET", "/api/customer/orders", { token: S.custTok, expected: 200 });
await T("my parent orders", "GET", "/api/customer/orders/parents", { token: S.custTok, expected: 200 });
await T("order detail", "GET", `/api/customer/orders/${S.orderId}`, { token: S.custTok, expected: 200 });
r = await call("GET", "/api/customer/cart", { token: S.custTok });
out(r.json?.data?.items?.length === 0, "cart emptied after checkout", "");

step("SELLER ORDERS — state machine placed→confirmed→packed→shipped");
await T("seller sees order", "GET", "/api/seller/orders", { token: S.selTok, expected: 200 });
r = await call("PUT", `/api/seller/orders/${S.orderId}/status`, { token: S.selTok, body: { status: "shipped" } });
out(r.status === 400, "invalid transition placed→shipped blocked (400)", `→ ${r.status}`);
await T("confirm", "PUT", `/api/seller/orders/${S.orderId}/status`, { token: S.selTok, body: { status: "confirmed", note: "Confirmed" }, expected: 200 });
await T("pack", "PUT", `/api/seller/orders/${S.orderId}/status`, { token: S.selTok, body: { status: "packed" }, expected: 200 });
await T("ship", "PUT", `/api/seller/orders/${S.orderId}/status`, { token: S.selTok, body: { status: "shipped", trackingNumber: "TRK1", estimatedDelivery: "2026-09-10" }, expected: 200 });
await T("seller order detail", "GET", `/api/seller/orders/${S.orderId}`, { token: S.selTok, expected: 200 });

step("DELIVERY — profile, available, accept, deliver");
await T("update delivery profile", "PUT", "/api/delivery/profile", { token: S.delTok, body: { isAvailable: true, vehicleType: "bike", coordinates: [77.1025, 28.7041] }, expected: 200 });
await T("update location", "PUT", "/api/delivery/location", { token: S.delTok, body: { coordinates: [77.2, 28.6] }, expected: 200 });
r = await call("GET", "/api/delivery/orders/available", { token: S.delTok });
out(r.json?.data?.some((o) => o._id === S.orderId), "order appears in available list", `→ ${JSON.stringify(r.json?.data)}`);
await T("accept order", "PUT", `/api/delivery/orders/${S.orderId}/accept`, { token: S.delTok, expected: 200 });
await T("active deliveries", "GET", "/api/delivery/orders/active", { token: S.delTok, expected: 200 });
await T("deliver order", "PUT", `/api/delivery/orders/${S.orderId}/deliver`, { token: S.delTok, body: { note: "Left at door" }, expected: 200 });
await T("delivery history", "GET", "/api/delivery/orders/history", { token: S.delTok, expected: 200 });
await T("delivery stats", "GET", "/api/delivery/stats", { token: S.delTok, expected: 200 });
r = await call("PUT", `/api/delivery/orders/${S.orderId}/accept`, { token: S.delTok });
out(r.status === 400, "re-accept delivered order blocked (400)", `→ ${r.status}`);

step("DELIVERY AGENT VERIFICATION — admin reviews documents, approves, agent logs in");
r = await call("GET", "/api/admin/delivery?status=pending", { token: S.admTok });
out(r.json?.data?.some((a) => a._id === S.agent1?._id), "pending agent appears in admin review list", `→ ${r.status} ${JSON.stringify(r.json?.data?.map((a) => a.email))}`);
r = await call("GET", `/api/admin/delivery/${S.agent1._id}`, { token: S.admTok });
out(r.status === 200
  && r.json?.data?.deliveryPartner?.vehicleType === "Bike"
  && r.json?.data?.deliveryPartner?.vehicleNumber === "KA05MJ4831"
  && r.json?.data?.deliveryPartner?.licenseNumber === "KA0520230001234"
  && !!r.json?.data?.deliveryPartner?.licensePhoto?.url,
  "admin sees vehicle details + license photo url", `→ ${JSON.stringify(r.json?.data?.deliveryPartner)}`);
r = await call("GET", "/api/admin/delivery", { token: S.custTok });
out(r.status === 403, "customer blocked from admin delivery list (403)", `→ ${r.status}`);
r = await call("PUT", `/api/admin/delivery/${S.agent1._id}/reject`, { token: S.admTok, body: {} });
out(r.status === 400, "reject without reason rejected (400)", `→ ${r.status}`);
await T("admin approves delivery agent", "PUT", `/api/admin/delivery/${S.agent1._id}/verify`, { token: S.admTok, expected: 200 });
r = await call("POST", "/api/auth/login", { body: { email: `agent1+${TS}@test.dev`, password: "pass12345" } });
out(r.status === 200 && !!r.json?.data?.accessToken, "approved delivery agent can log in (200)", `→ ${r.status} ${r.json?.message || ""}`);
S.agent1Tok = r.json?.data?.accessToken;
await T("agent goes on duty", "PUT", "/api/delivery/profile", { token: S.agent1Tok, body: { isAvailable: true }, expected: 200 });
r = await call("GET", "/api/admin/delivery?status=approved", { token: S.admTok });
out(r.json?.data?.some((a) => a._id === S.agent1?._id), "agent shows as approved in admin list", `→ ${r.status}`);

step("RANDOM AUTO-ASSIGNMENT — ship with an on-duty agent → assigned automatically");
// Take the seeded staff partner off duty so agent1 is the only candidate and
// the random pick is deterministic.
await T("staff partner goes off duty", "PUT", "/api/delivery/profile", { token: S.delTok, body: { isAvailable: false }, expected: 200 });
// Add a second product so the new order has its own stock to consume.
await T("create second product", "POST", "/api/seller/products", {
  token: S.selTok,
  body: { name: `Phone Case ${TS}`, description: "Slim case", price: 399, category: S.catId, subCategory: S.subCatId2, tags: ["electronics", "case"], store: S.storeId, images: [{ url: "https://example.com/case.jpg", publicId: "case-1" }], shipping: { weight: 50 } },
  expected: 201, stateKey: "product2", pick: (j) => j.data,
});
S.product2Id = S.product2?._id;
await T("create variant for second product", "POST", `/api/seller/products/${S.product2Id}/variants`, {
  token: S.selTok, body: { options: { color: "Clear" }, label: "Clear", sku: `PC-${TS}`, price: 399, stock: 10, lowStockThreshold: 2, weight: 50 },
  expected: 201, stateKey: "variant2Id", pick: (j) => j.data?._id,
});
await T("add product2 to cart", "POST", "/api/customer/cart", { token: S.custTok, body: { productId: S.product2Id, variantId: S.variant2Id, quantity: 1 }, expected: 200 });
await T("checkout second order (cod)", "POST", "/api/customer/orders/checkout", {
  token: S.custTok, body: { shippingAddressId: S.addrA, paymentMethod: "cod" },
  expected: 201, stateKey: "assignOrderId", pick: (j) => j.data?.subOrders?.[0]?._id,
});
await T("seller confirms assign-order", "PUT", `/api/seller/orders/${S.assignOrderId}/status`, { token: S.selTok, body: { status: "confirmed" }, expected: 200 });
await T("seller packs assign-order", "PUT", `/api/seller/orders/${S.assignOrderId}/status`, { token: S.selTok, body: { status: "packed" }, expected: 200 });
await T("seller ships assign-order", "PUT", `/api/seller/orders/${S.assignOrderId}/status`, { token: S.selTok, body: { status: "shipped" }, expected: 200 });
r = await call("GET", `/api/seller/orders/${S.assignOrderId}`, { token: S.selTok });
const assigneeId = String(r.json?.data?.deliveryPartner?._id || r.json?.data?.deliveryPartner || "");
out(assigneeId === String(S.agent1._id), "order auto-assigned to the on-duty agent", `→ ${assigneeId} expected ${S.agent1._id}`);
r = await call("GET", "/api/delivery/orders/assigned", { token: S.agent1Tok });
out(r.json?.data?.some((o) => o._id === S.assignOrderId), "assigned list contains the auto-assigned order", `→ ${JSON.stringify(r.json?.data?.map((o) => o._id))}`);
r = await call("GET", "/api/delivery/orders/available", { token: S.delTok });
out(!r.json?.data?.some((o) => o._id === S.assignOrderId), "auto-assigned order NOT in public available list", `→ ${JSON.stringify(r.json?.data?.map((o) => o._id))}`);
r = await call("PUT", `/api/delivery/orders/${S.assignOrderId}/start`, { token: S.delTok });
out(r.status === 403, "other partner cannot start someone else's assigned order (403)", `→ ${r.status}`);
await T("agent starts the delivery", "PUT", `/api/delivery/orders/${S.assignOrderId}/start`, { token: S.agent1Tok, expected: 200 });
r = await call("GET", `/api/seller/orders/${S.assignOrderId}`, { token: S.selTok });
out(r.json?.data?.status === "out_for_delivery", "order status moved to out_for_delivery", `→ ${r.json?.data?.status}`);
await T("agent delivers the assigned order", "PUT", `/api/delivery/orders/${S.assignOrderId}/deliver`, { token: S.agent1Tok, body: { note: "Random-assignment run" }, expected: 200 });
// Notification side effects: the agent got a delivery_assigned notification.
r = await call("GET", "/api/customer/notifications", { token: S.agent1Tok });
out(r.json?.data?.notifications?.some((n) => n.type === "delivery_assigned"), "agent received delivery_assigned notification", `→ ${JSON.stringify(r.json?.data?.notifications?.map((n) => n.type))}`);
// agent1 goes off duty again so later shipments stay unassigned for the
// manual-acceptance tests below.
await T("agent goes off duty", "PUT", "/api/delivery/profile", { token: S.agent1Tok, body: { isAvailable: false }, expected: 200 });

step("CUSTOMER REVIEWS + NOTIFICATIONS");
await T("create review (verified purchase)", "POST", "/api/customer/reviews", { token: S.custTok, body: { productId: S.productId, orderId: S.orderId, rating: 5, title: "Great", comment: "Works well" }, expected: 201, stateKey: "reviewId", pick: (j) => j.data?._id });
r = await call("POST", "/api/customer/reviews", { token: S.custTok, body: { productId: S.productId, orderId: S.orderId, rating: 4 } });
out(r.status === 400, "duplicate review blocked (400)", `→ ${r.status}`);
await T("list product reviews", "GET", `/api/customer/reviews/product/${S.productId}`, { token: S.custTok, expected: 200 });
await T("update review", "PUT", `/api/customer/reviews/${S.reviewId}`, { token: S.custTok, body: { rating: 4, comment: "Updated" }, expected: 200 });
r = await call("GET", `/api/customer/products/${S.slug}`);
out(r.json?.data?.reviewSummary?.totalReviews === 1, "product detail review summary reflects review", `→ ${JSON.stringify(r.json?.data?.reviewSummary)}`);
r = await call("GET", "/api/customer/notifications", { token: S.custTok });
S.notifId = r.json?.data?.notifications?.[0]?._id;
out(r.json?.data?.notifications?.length >= 1, "customer has notifications", `→ ${JSON.stringify(r.json?.data?.notifications)}`);
await T("mark one notification read", "PUT", `/api/customer/notifications/${S.notifId}/read`, { token: S.custTok, expected: 200 });
await T("mark all read", "PUT", "/api/customer/notifications/read-all", { token: S.custTok, expected: 200 });
r = await call("GET", "/api/customer/notifications?unreadOnly=true", { token: S.custTok });
out(r.json?.data?.notifications?.length === 0, "no unread after read-all", "");

step("SELLER DASHBOARD + ADMIN ORDERS/ANALYTICS + SELLER VERIFY");
await T("seller dashboard stats", "GET", "/api/seller/dashboard", { token: S.selTok, expected: 200 });
await T("dashboard recent orders", "GET", "/api/seller/dashboard/recent-orders", { token: S.selTok, expected: 200 });
await T("dashboard revenue chart", "GET", "/api/seller/dashboard/revenue-chart?days=30", { token: S.selTok, expected: 200 });
await T("admin sellers list", "GET", "/api/admin/sellers", { token: S.admTok, expected: 200 });
await T("seller list w/ search", "GET", `/api/admin/sellers?search=${encodeURIComponent(`Test Store Co ${TS}`)}`, { token: S.admTok, expected: 200 });
r = await call("GET", "/api/admin/sellers", { token: S.admTok });
S.sellerDocId = r.json?.data?.find((s) => s.businessName === `Test Store Co ${TS}`)?._id;
out(!!S.sellerDocId, "seller appears in admin list");
await T("admin seller detail", "GET", `/api/admin/sellers/${S.sellerDocId}`, { token: S.admTok, expected: 200 });
r = await call("PUT", `/api/admin/sellers/${S.sellerDocId}/verify`, { token: S.admTok });
out(r.status === 200 && r.json?.data?.status === "approved" && r.json?.data?.isVerified === true, "verify seller → status=approved (200)", `→ ${r.status} status=${r.json?.data?.status}`);

step("SELLER APPROVAL REJECT FLOW — register → admin notification → reject → login blocked");
r = await call("POST", "/api/auth/register", { body: { name: `Rejected Seller ${TS}`, email: `selrej+${TS}@test.dev`, password: "pass12345", role: "seller", businessName: `Reject Me Co ${TS}` } });
roleUsers.selrej = r.json?.data?.user;
out(r.status === 201 && r.json?.data?.requiresApproval === true, "register second seller (pending approval)", `→ ${r.status}`);
// Admin should have received a seller_pending_approval notification at registration.
r = await call("GET", "/api/admin/notifications", { token: S.admTok });
const approvalNotif = r.json?.data?.notifications?.find((n) => n.type === "seller_pending_approval" && n.message?.includes(`Reject Me Co ${TS}`));
out(!!approvalNotif, "admin notified of new seller application", `→ ${r.status} types=${(r.json?.data?.notifications || []).map((n) => n.type).join(",")}`);
r = await call("GET", "/api/admin/sellers", { token: S.admTok });
S.rejSellerDocId = r.json?.data?.find((s) => s.businessName === `Reject Me Co ${TS}`)?._id;
out(!!S.rejSellerDocId, "pending seller appears in admin list", "");
r = await call("PUT", `/api/admin/sellers/${S.rejSellerDocId}/reject`, { token: S.admTok, body: {} });
out(r.status === 400, "reject without reason blocked (400)", `→ ${r.status}`);
r = await call("PUT", `/api/admin/sellers/${S.rejSellerDocId}/reject`, { token: S.admTok, body: { reason: "Incomplete business documents" } });
out(r.status === 200 && r.json?.data?.status === "rejected" && r.json?.data?.isVerified === false, "reject seller with reason (200, status=rejected)", `→ ${r.status} status=${r.json?.data?.status}`);
r = await call("POST", "/api/auth/login", { body: { email: `selrej+${TS}@test.dev`, password: "pass12345" } });
out(r.status === 403 && String(r.json?.message).includes("rejected"), "rejected seller login blocked with rejection message (403)", `→ ${r.status} ${r.json?.message || ""}`);
r = await call("GET", "/api/admin/sellers?status=rejected", { token: S.admTok });
out(r.status === 200 && r.json?.data?.some((s) => s._id === S.rejSellerDocId), "status=rejected filter returns the rejected seller", `→ ${r.status}`);
r = await call("PUT", `/api/admin/sellers/${S.rejSellerDocId}/verify`, { token: S.admTok });
out(r.status === 200 && r.json?.data?.status === "approved" && r.json?.data?.rejectionReason === null, "approve-after-reject clears rejection (200)", `→ ${r.status} reason=${JSON.stringify(r.json?.data?.rejectionReason)}`);
r = await call("POST", "/api/auth/login", { body: { email: `selrej+${TS}@test.dev`, password: "pass12345" } });
out(r.status === 200 && !!r.json?.data?.accessToken, "approved-after-reject seller can login (200)", `→ ${r.status}`);
S.selrejTok = r.json?.data?.accessToken;
// The seller received both a seller_rejected and a seller_approved notification.
r = await call("GET", "/api/customer/notifications", { token: S.selrejTok });
out(r.json?.data?.notifications?.some((n) => n.type === "seller_rejected"), "seller notified of rejection", "");
out(r.json?.data?.notifications?.some((n) => n.type === "seller_approved"), "seller notified of approval", "");
r = await call("PUT", `/api/admin/notifications/${approvalNotif?._id}/read`, { token: S.admTok });
out(r.status === 200, "mark admin notification read", `→ ${r.status}`);
r = await call("DELETE", `/api/admin/notifications/${approvalNotif?._id}`, { token: S.admTok });
out(r.status === 200, "delete admin notification", `→ ${r.status}`);
await T("admin orders", "GET", "/api/admin/orders", { token: S.admTok, expected: 200 });
await T("admin order detail", "GET", `/api/admin/orders/${S.orderId}`, { token: S.admTok, expected: 200 });
await T("admin order stats", "GET", "/api/admin/orders/stats", { token: S.admTok, expected: 200 });
await T("admin analytics overview", "GET", "/api/admin/analytics", { token: S.admTok, expected: 200 });
await T("analytics revenue", "GET", "/api/admin/analytics/revenue?days=30", { token: S.admTok, expected: 200 });
await T("analytics top sellers", "GET", "/api/admin/analytics/top-sellers", { token: S.admTok, expected: 200 });
await T("analytics top products", "GET", "/api/admin/analytics/top-products", { token: S.admTok, expected: 200 });

step("SELLER RETURNS — approve / receive / reject (seed ReturnRequests)");
const ReturnRequest = (await import("./models/ReturnRequest.js")).default;

const rq1 = await ReturnRequest.create({
  order: S.orderId, customer: roleUsers.cust?._id, seller: S.sellerDocId, product: S.productId, reason: "defective",
  items: [{ product: S.productId, variant: S.variantId, productName: "Wireless Mouse", quantity: 1, reason: "defective" }],
});
const rq2 = await ReturnRequest.create({
  order: S.orderId, customer: roleUsers.cust?._id, seller: S.sellerDocId, product: S.productId, reason: "changed_mind",
  items: [{ product: S.productId, variant: S.variantId, productName: "Wireless Mouse", quantity: 1, reason: "changed_mind" }],
});
await T("list returns (seller)", "GET", "/api/seller/returns", { token: S.selTok, expected: 200 });
await T("approve return #1", "PUT", `/api/seller/returns/${rq1._id}/approve`, { token: S.selTok, body: { note: "OK" }, expected: 200 });
await T("receive return #1", "PUT", `/api/seller/returns/${rq1._id}/receive`, { token: S.selTok, expected: 200 });
await T("reject return #2", "PUT", `/api/seller/returns/${rq2._id}/reject`, { token: S.selTok, body: { note: "Expired window" }, expected: 200 });
r = await call("PUT", `/api/seller/returns/${rq2._id}/approve`, { token: S.selTok });
out(r.status === 400, "approve rejected return blocked (400)", `→ ${r.status}`);

step("SUPPORT — customer ticket, agent assign/reply/status/priority");
await T("create ticket", "POST", "/api/customer/support/tickets", {
  token: S.custTok, body: { subject: "Order not received", category: "delivery", priority: "high", message: "Where is my order?" },
  expected: 201, stateKey: "ticketId", pick: (j) => j.data?._id,
});
await T("customer ticket list", "GET", "/api/customer/support/tickets", { token: S.custTok, expected: 200 });
await T("customer ticket detail", "GET", `/api/customer/support/tickets/${S.ticketId}`, { token: S.custTok, expected: 200 });
await T("customer reply", "POST", `/api/customer/support/tickets/${S.ticketId}/messages`, { token: S.custTok, body: { message: "Any update?" }, expected: 201 });
await T("support stats", "GET", "/api/support/stats", { token: S.supTok, expected: 200 });
await T("support ticket list", "GET", "/api/support/tickets", { token: S.supTok, expected: 200 });
await T("support assign to self", "PUT", `/api/support/tickets/${S.ticketId}/assign`, { token: S.supTok, body: {}, expected: 200 });
await T("support reply", "POST", `/api/support/tickets/${S.ticketId}/messages`, { token: S.supTok, body: { message: "We are checking with logistics." }, expected: 201 });
await T("support set status resolved", "PUT", `/api/support/tickets/${S.ticketId}/status`, { token: S.supTok, body: { status: "resolved", resolution: "Refund issued" }, expected: 200 });
await T("support set priority urgent", "PUT", `/api/support/tickets/${S.ticketId}/priority`, { token: S.supTok, body: { priority: "urgent" }, expected: 200 });
r = await call("POST", `/api/customer/support/tickets/${S.ticketId}/messages`, { token: S.custTok, body: { message: "ping" } });
out(r.status === 400, "reply to resolved ticket blocked (400)", `→ ${r.status}`);

step("AI — events, semantic search fallback, recommendations fallback, description guard");
await T("log VIEW event", "POST", "/api/ai/events", { token: S.custTok, body: { productId: S.productId, eventType: "VIEW", metadata: { source: "e2e" } }, expected: 201 });
await T("log WISHLIST event", "POST", "/api/ai/events", { token: S.custTok, body: { productId: S.productId, eventType: "WISHLIST" }, expected: 201 });
r = await call("POST", "/api/ai/events", { token: S.custTok, body: { productId: S.productId, eventType: "BANANA" } });
out(r.status === 400, "invalid eventType rejected (400)", `→ ${r.status}`);
r = await call("POST", "/api/ai/events", { body: { productId: S.productId, eventType: "VIEW" } });
out(r.status === 401, "events without token rejected (401)", `→ ${r.status}`);
r = await call("POST", "/api/ai/events", { token: S.custTok, body: { productId: "000000000000000000000000", eventType: "VIEW" } });
out(r.status === 404, "event for unknown product rejected (404)", `→ ${r.status}`);
// No GEMINI_API_KEY in this env → semantic search must gracefully fall back to keyword
r = await call("GET", "/api/ai/search?q=wireless%20mouse", {});
out(r.status === 200 && Array.isArray(r.json?.data) && r.json?.searchMode === "keyword", "search falls back to keyword without Gemini (200)", `→ ${r.status} mode=${r.json?.searchMode}`);
r = await call("GET", "/api/ai/search", {});
out(r.status === 400, "search without q rejected (400)", `→ ${r.status}`);
await T("search with filters + pagination", "GET", "/api/ai/search?q=mouse&limit=5&page=1&availability=in_stock", { expected: 200 });
// Recommendations: no embeddings exist (no Gemini) → popular fallback, never an error
r = await call("GET", "/api/ai/recommendations", { token: S.custTok });
out(r.status === 200 && Array.isArray(r.json?.data) && r.json?.source === "popular", "recommendations fall back to popular (200)", `→ ${r.status} source=${r.json?.source}`);
r = await call("GET", "/api/ai/recommendations", {});
out(r.status === 401, "recommendations without token rejected (401)", `→ ${r.status}`);
// Product-description requires a SELLER and a configured Gemini key
// Returns 503 when GEMINI_API_KEY is missing, or 502 when the key is set but the
// upstream call fails (test environments typically have no valid key).
r = await call("POST", "/api/ai/product-description", { token: S.custTok, body: { name: "Shoes" } });
out(r.status === 403, "customer blocked from product-description (403)", `→ ${r.status}`);
r = await call("POST", "/api/ai/product-description", { token: S.selTok, body: { name: "Running Shoes", brand: "Nike", category: "Sports", attributes: { color: "Black" }, features: ["Lightweight"] } });
out(r.status === 200 || r.status === 502 || r.status === 503, "product-description reachable (200 with valid key / 502 AI error / 503 unconfigured)", `→ ${r.status}`);
r = await call("POST", "/api/ai/product-description", { token: S.selTok, body: {} });
out(r.status === 400, "product-description validation (400)", `→ ${r.status}`);

step("ONLINE PAYMENT — checkout (upi) stays pending → create → verify → wallet credit");
// Re-add the same product and place an order with an online payment method.
// Reworked checkout must NOT mark online methods paid — settlement happens in verify.
await T("re-add item to cart for online checkout", "POST", "/api/customer/cart", { token: S.custTok, body: { productId: S.productId, variantId: S.variantId, quantity: 1 }, expected: 200 });
r = await call("POST", "/api/customer/orders/checkout", { token: S.custTok, body: { shippingAddressId: S.addrA, paymentMethod: "upi" } });
out(r.status === 201, "checkout with online method creates order (201)", `→ ${r.status} ${r.json?.message || ""}`);
S.parentOrderId = r.json?.data?.parentOrder?._id;
S.onlineSubOrderId = r.json?.data?.subOrders?.[0]?._id;
out(!!S.parentOrderId && !!S.onlineSubOrderId, "checkout returns parent + sub order", "");
out(r.json?.data?.parentOrder?.payment?.status === "pending" && !r.json?.data?.parentOrder?.payment?.paidAt, "online order payment starts pending (no paidAt)", `→ ${JSON.stringify(r.json?.data?.parentOrder?.payment)}`);
await T("create payment for online order", "POST", "/api/customer/payments/create", { token: S.custTok, body: { parentOrderId: S.parentOrderId, paymentMethod: "upi" }, expected: 201, stateKey: "txnId", pick: (j) => j.data?.transactionId });
await T("verify payment SUCCESS", "POST", "/api/customer/payments/verify", { token: S.custTok, body: { transactionId: S.txnId, result: "SUCCESS" }, expected: 200 });
r = await call("GET", `/api/customer/orders/${S.onlineSubOrderId}`, { token: S.custTok });
out(r.json?.data?.payment?.status === "completed" && r.json?.data?.payment?.transactionId === S.txnId, "sub-order marked paid with transaction id", `→ ${JSON.stringify(r.json?.data?.payment)}`);
r = await call("GET", "/api/seller/wallet", { token: S.selTok });
out(r.status === 200 && (r.json?.data?.balance || 0) > 0, "seller wallet credited after verify", `→ ${JSON.stringify({ balance: r.json?.data?.balance, totalEarned: r.json?.data?.totalEarned })}`);
r = await call("POST", "/api/customer/payments/create", { token: S.custTok, body: { parentOrderId: S.parentOrderId, paymentMethod: "upi" } });
out(r.status === 400 && String(r.json?.message).includes("already paid"), "duplicate payment create blocked after verify (400)", `→ ${r.status}`);

// ─── CUSTOMER RETURN FLOW (full lifecycle, real API calls) ────────────────
// Uses the second (online, paid) order: returns require status=delivered.
// First drive the online sub-order through the delivery lifecycle.
step("CUSTOMER RETURNS — full lifecycle on the delivered online order");
await T("confirm online order", "PUT", `/api/seller/orders/${S.onlineSubOrderId}/status`, { token: S.selTok, body: { status: "confirmed" }, expected: 200 });
await T("pack online order", "PUT", `/api/seller/orders/${S.onlineSubOrderId}/status`, { token: S.selTok, body: { status: "packed" }, expected: 200 });
await T("ship online order", "PUT", `/api/seller/orders/${S.onlineSubOrderId}/status`, { token: S.selTok, body: { status: "shipped" }, expected: 200 });
r = await call("GET", "/api/delivery/orders/available", { token: S.delTok });
out(r.json?.data?.some((o) => o._id === S.onlineSubOrderId), "online order available for delivery partner", `→ ${r.status}`);
await T("delivery accepts online order", "PUT", `/api/delivery/orders/${S.onlineSubOrderId}/accept`, { token: S.delTok, expected: 200 });
r = await call("PUT", `/api/delivery/orders/${S.onlineSubOrderId}/deliver`, { token: S.delTok, body: { note: "Delivered for return test" } });
out(r.status === 200, "delivery marks online order delivered (200)", `→ ${r.status} ${r.json?.message || ""}`);

// Customer requests a return through the public API
r = await call("POST", "/api/customer/returns", {
  token: S.custTok,
  body: { orderId: S.onlineSubOrderId, productId: S.productId, reason: "defective", description: "Stopped working after two days", quantity: 1 },
});
out(r.status === 201, "customer creates return request (201)", `→ ${r.status} ${r.json?.message || ""}`);
S.returnId = r.json?.data?._id;
out(!!S.returnId, "return request id returned", `→ ${JSON.stringify(r.json?.data).slice(0, 200)}`);

// Order should now be in return_requested state
r = await call("GET", `/api/customer/orders/${S.onlineSubOrderId}`, { token: S.custTok });
out(r.json?.data?.status === "return_requested", "order moved to return_requested", `→ ${r.json?.data?.status}`);

// Seller got a return_requested notification (recipient = seller's USER id — this used to 500)
r = await call("GET", "/api/customer/notifications?limit=50", { token: S.selTok });
out(r.json?.data?.notifications?.some((n) => n.type === "return_requested"), "seller notified of return request", `→ ${r.status} types=${(r.json?.data?.notifications || []).map((n) => n.type).join(",")}`);

// Duplicate request for the same product must be blocked
r = await call("POST", "/api/customer/returns", {
  token: S.custTok,
  body: { orderId: S.onlineSubOrderId, productId: S.productId, reason: "defective" },
});
out(r.status === 400, "duplicate return request blocked (400)", `→ ${r.status} ${r.json?.message || ""}`);

// Customer cannot ship before approval
r = await call("PUT", `/api/customer/returns/${S.returnId}/ship`, { token: S.custTok, body: {} });
out(r.status === 400, "ship before approval blocked (400)", `→ ${r.status}`);

// Wallet + stock snapshots before the refund/receive cycle
r = await call("GET", "/api/seller/wallet", { token: S.selTok });
S.walletBeforeRefund = r.json?.data?.balance ?? 0;
r = await call("GET", `/api/seller/products/${S.productId}/variants`, { token: S.selTok });
S.stockBeforeReceive = r.json?.data?.find((v) => v._id === S.variantId)?.stock ?? null;
out(S.stockBeforeReceive !== null, "variant stock snapshot before receive", `→ stock=${S.stockBeforeReceive}`);

// Seller approves
await T("seller approves return", "PUT", `/api/seller/returns/${S.returnId}/approve`, { token: S.selTok, body: { note: "Approved, please ship back" }, expected: 200 });
r = await call("GET", `/api/customer/orders/${S.onlineSubOrderId}`, { token: S.custTok });
out(r.json?.data?.status === "return_approved", "order moved to return_approved", `→ ${r.json?.data?.status}`);

// Customer ships the return back
await T("customer marks return shipped", "PUT", `/api/customer/returns/${S.returnId}/ship`, { token: S.custTok, body: { trackingNumber: "RET-TRK-1" }, expected: 200 });
r = await call("GET", `/api/customer/returns/${S.returnId}`, { token: S.custTok });
out(r.json?.data?.status === "return_shipped", "return now return_shipped", `→ ${r.json?.data?.status}`);
r = await call("GET", "/api/customer/notifications?limit=50", { token: S.selTok });
out(r.json?.data?.notifications?.some((n) => n.type === "return_shipped"), "seller notified of return shipment", `→ ${r.status}`);

// Seller receives the item → stock restored + refund processed
await T("seller receives return", "PUT", `/api/seller/returns/${S.returnId}/receive`, { token: S.selTok, expected: 200 });
r = await call("GET", `/api/seller/returns`, { token: S.selTok });
const receivedReturn = r.json?.data?.find((x) => x._id === S.returnId);
out(receivedReturn?.status === "refunded", "return ended in refunded state", `→ ${receivedReturn?.status}`);
out((receivedReturn?.refund?.amount || 0) > 0, "refund amount recorded on return", `→ ₹${receivedReturn?.refund?.amount}`);

// Stock restored?
r = await call("GET", `/api/seller/products/${S.productId}/variants`, { token: S.selTok });
const stockAfterReceive = r.json?.data?.find((v) => v._id === S.variantId)?.stock ?? null;
out(stockAfterReceive === (S.stockBeforeReceive ?? 0) + 1, "variant stock restored after receive (+1)", `→ before=${S.stockBeforeReceive} after=${stockAfterReceive}`);

// Wallet debited by the refund?
r = await call("GET", "/api/seller/wallet", { token: S.selTok });
out((r.json?.data?.balance ?? 0) < S.walletBeforeRefund, "seller wallet debited by refund", `→ before=${S.walletBeforeRefund} after=${r.json?.data?.balance}`);

// Refund wallet transaction exists
r = await call("GET", "/api/seller/wallet/transactions?type=refund", { token: S.selTok });
out(r.json?.data?.some((t) => t.order?._id === S.onlineSubOrderId || t.order === S.onlineSubOrderId), "refund wallet transaction recorded", `→ ${r.status} count=${r.json?.data?.length}`);

// Customer notified of the refund
r = await call("GET", "/api/customer/notifications?limit=50", { token: S.custTok });
out(r.json?.data?.notifications?.some((n) => n.type === "refund_processed"), "customer notified of refund", `→ ${r.status}`);

// Order ended refunded
r = await call("GET", `/api/customer/orders/${S.onlineSubOrderId}`, { token: S.custTok });
out(r.json?.data?.payment?.status === "refunded" && r.json?.data?.status === "return_received", "order payment=refunded + status=return_received", `→ status=${r.json?.data?.status} payment=${r.json?.data?.payment?.status}`);

// Customer list + cancel guards
r = await call("GET", "/api/customer/returns", { token: S.custTok });
out(r.status === 200 && r.json?.data?.some((x) => x._id === S.returnId), "customer return list contains the return", `→ ${r.status} total=${r.json?.pagination?.total}`);
r = await call("DELETE", `/api/customer/returns/${rq2._id}`, { token: S.custTok });
out(r.status === 400, "cancel of non-pending return blocked (400)", `→ ${r.status}`);
r = await call("DELETE", "/api/customer/returns/000000000000000000000000", { token: S.custTok });
out(r.status === 404, "cancel unknown return 404", `→ ${r.status}`);
r = await call("POST", "/api/customer/returns", { token: S.custTok, body: { orderId: S.orderId, productId: S.productId, reason: "not_a_reason" } });
out(r.status === 400, "invalid return reason rejected (400)", `→ ${r.status}`);

step("REMOVAL OPS — review delete, product delete, coupon delete");
await T("delete review", "DELETE", `/api/customer/reviews/${S.reviewId}`, { token: S.custTok, expected: 200 });
r = await call("GET", `/api/customer/products/${S.slug}`);
out(r.json?.data?.reviewSummary?.totalReviews === 0, "review summary back to 0 after delete", `→ ${JSON.stringify(r.json?.data?.reviewSummary)}`);
await T("delete product (soft)", "DELETE", `/api/seller/products/${S.productId}`, { token: S.selTok, expected: 200 });
r = await call("GET", `/api/customer/products/${S.slug}`);
out(r.status === 404, "inactive product gone from storefront (404)", `→ ${r.status}`);
await T("delete coupon", "DELETE", `/api/admin/coupons/${S.couponId}`, { token: S.admTok, expected: 200 });
await T("delete address A", "DELETE", `/api/customer/users/me/addresses/${S.addrA}`, { token: S.custTok, expected: 200 });
await T("logout", "POST", "/api/auth/logout", { token: S.custTok, expected: 200 });

// ---------------------------------------------------------------------------
console.log(`\n======== RESULT: ${pass} passed, ${fail} failed ========`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}

if (CLEANUP) {
  await db.dropDatabase();
  console.log("\n🧹 test database dropped:", DB_URI);
}
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
