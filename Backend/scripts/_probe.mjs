// Temporary probe: exercise all new endpoints + socket path against the live
// server to reproduce a crash. Deleted after use.
process.env.NODE_ENV = "test";
await import("dotenv/config");
const mongoose = (await import("mongoose")).default;
const jwt = (await import("jsonwebtoken")).default;
const { io } = await import("socket.io-client");
const User = (await import("../models/User.js")).default;
const Seller = (await import("../models/Seller.js")).default;
const Product = (await import("../models/Product.js")).default;

const BASE = "http://localhost:3000/api";
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const tokenFor = (id) => jwt.sign({ id: String(id) }, JWT_SECRET);

const api = async (path, { method = "GET", token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

try {
  await mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL);

  // Real-ish records: reuse existing if possible, else create throwaway
  const product = await Product.findOne({ status: "active" }).select("_id slug").lean();
  if (!product) throw new Error("no active product");

  let customer = await User.findOne({ role: "customer", isActive: true }).select("_id").lean();
  let sellerUser = await User.findOne({ role: "seller", isActive: true }).select("_id").lean();
  if (!customer) { customer = await User.create({ name: "Probe Cust", email: `probe-cust-${Date.now()}@test.local`, password: "password123" }); }
  if (!sellerUser) { sellerUser = await User.create({ name: "Probe Seller", email: `probe-sell-${Date.now()}@test.local`, password: "password123" }); }
  console.log("product:", product.slug, "| customer:", customer._id, "| sellerUser:", sellerUser._id);

  const checks = [];

  // 1. Public Q&A
  const qa = await api(`/customer/products/${product.slug}/qa`);
  checks.push(`qa ${qa.status}`);

  // 2. AI suggestions
  const sug = await api("/ai/search-suggestions?q=ear&limit=5");
  checks.push(`suggestions ${sug.status}`);

  // 3. Malformed ids → must NOT crash (CastError path)
  const badMsg = await api("/customer/messages/not-an-objectid", { token: tokenFor(customer._id) });
  checks.push(`bad-conv-id ${badMsg.status}`);
  const badQA = await api("/customer/products/earphones/qa?x=1");
  checks.push(`qa-again ${badQA.status}`);

  // 4. Full message flow via REST (exercises pushMessage + notification)
  const ask = await api("/customer/messages", {
    method: "POST",
    token: tokenFor(customer._id),
    body: { productId: String(product._id), text: `Probe question ${Date.now()}?` },
  });
  checks.push(`ask ${ask.status}`);
  const convId = ask.json?.data?.conversation?._id;
  if (convId) {
    const reply = await api(`/seller/messages/${convId}`, {
      method: "POST", token: tokenFor(sellerUser._id), body: { text: "Probe answer" },
    });
    checks.push(`reply ${reply.status}`);
    const read = await api(`/customer/messages/${convId}`, { token: tokenFor(customer._id) });
    checks.push(`read ${read.status}`);
  }

  // 5. Socket path: connect, register, message:send with ack
  await new Promise((resolve) => {
    const socket = io("http://localhost:3000", { transports: ["websocket", "polling"], reconnectionAttempts: 2 });
    const timer = setTimeout(() => { console.log("socket connect TIMEOUT"); socket.close(); resolve(); }, 8000);
    socket.on("connect_error", (e) => { console.log("socket connect_error:", e.message); clearTimeout(timer); socket.close(); resolve(); });
    socket.on("connect", () => {
      socket.emit("register", String(customer._id));
      setTimeout(() => {
        if (convId) {
          socket.emit("message:send", { conversationId: convId, text: "Probe socket message" }, (res) => {
            checks.push(`socket-send ${res?.success ? "ok" : "fail:" + res?.message}`);
            clearTimeout(timer);
            socket.close();
            resolve();
          });
        } else {
          clearTimeout(timer); socket.close(); resolve();
        }
      }, 500);
    });
  });

  console.log("check results:", checks.join(" | "));
  console.log("PROBE DONE — now verify server is still alive");
} finally {
  await mongoose.disconnect();
}