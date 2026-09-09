// Temporary: clean up probe leftovers + test seller-side read with a verified seller.
process.env.NODE_ENV = "test";
await import("dotenv/config");
const mongoose = (await import("mongoose")).default;
const jwt = (await import("jsonwebtoken")).default;
const User = (await import("../models/User.js")).default;
const Seller = (await import("../models/Seller.js")).default;
const Conversation = (await import("../models/Conversation.js")).default;
const Message = (await import("../models/Message.js")).default;
const Notification = (await import("../models/Notification.js")).default;

const BASE = "http://localhost:3000/api";
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const tokenFor = (id) => jwt.sign({ id: String(id) }, JWT_SECRET);
const api = async (path, { method = "GET", token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

try {
  await mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL);
  const skip = () => { throw new Error("SKIP"); };
  const skipIf = (cond, msg) => { if (cond) { console.log(msg); skip(); } };

  // 1. Clean up probe leftovers (created by _probe.mjs on customer 6a9ad979ca46aceede2cca52)
  const probeCustomer = "6a9ad979ca46aceede2cca52";
  const convs = await Conversation.find({ customer: probeCustomer }).select("_id").lean();
  const convIds = convs.map((c) => c._id);
  if (convIds.length) {
    await Message.deleteMany({ conversation: { $in: convIds } });
    await Conversation.deleteMany({ _id: { $in: convIds } });
    await Notification.deleteMany({ data: { entityType: "conversation", entityId: { $in: convIds } } });
    console.log("cleaned", convIds.length, "probe conversation(s)");
  } else {
    console.log("no probe conversations found");
  }

  // 2. Find the REAL verified seller and exercise seller-side read
  const sellerProfile = await Seller.findOne({ isVerified: true, isActive: true }).select("user").lean();
  skipIf(!sellerProfile, "no verified seller found");
  const sellerUser = await User.findById(sellerProfile.user).select("_id name").lean();
  console.log("verified seller:", sellerUser._id, sellerUser.name);

  const sellerList = await api("/seller/messages", { token: tokenFor(sellerUser._id) });
  console.log("seller list:", sellerList.status, "conversations:", sellerList.json?.data?.length ?? "?");

  const conv = sellerList.json?.data?.[0];
  if (conv) {
    const detail = await api(`/seller/messages/${conv._id}`, { token: tokenFor(sellerUser._id) });
    console.log("seller conv detail:", detail.status, "messages:", detail.json?.data?.messages?.length ?? "?");
    // notification click deep-link endpoint is frontend-only; simulate what it calls
    const notif = await Notification.findOne({ recipient: sellerUser._id, type: "new_message" }).select("data title").lean();
    console.log("seller new_message notification:", notif ? `yes → ${notif.data?.entityId}` : "none");
  } else {
    console.log("verified seller has no conversations");
  }
  console.log("PROBE2 DONE");
} catch (err) {
  if (err.message === "SKIP") console.log("probe2 skipped part");
  else throw err;
} finally {
  await mongoose.disconnect();
}