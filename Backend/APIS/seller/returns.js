import { Router } from "express";
import ReturnRequest from "../../models/ReturnRequest.js";
import Order from "../../models/Order.js";
import Variant from "../../models/Variant.js";
import Notification from "../../models/Notification.js";

const router = Router();

// List all return requests for this seller
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, status } = req.query;
    const filter = { seller: req.seller._id };
    if (status) filter.status = status;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [returns, total] = await Promise.all([
      ReturnRequest.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("customer", "name email").populate("order", "orderNumber").populate("product", "name slug images").lean(),
      ReturnRequest.countDocuments(filter),
    ]);

    res.json({ success: true, data: returns, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Approve a return request (pending → approved)
router.put("/:returnId/approve", async (req, res) => {
    const { note = "" } = req.body;
    const returnReq = await ReturnRequest.findOne({ _id: req.params.returnId, seller: req.seller._id });
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });
    if (returnReq.status !== "pending") return res.status(400).json({ success: false, message: `Cannot approve in "${returnReq.status}" status` });

    returnReq.status = "approved";
    returnReq.sellerNote = note;
    returnReq.statusHistory.push({ status: "approved", note, changedBy: req.user._id });
    await returnReq.save();

    await Order.findByIdAndUpdate(returnReq.order, { status: "return_approved" });
    await Notification.create({ recipient: returnReq.customer, type: "return_approved", title: "Return Approved", message: "Your return has been approved. Please ship the item back.", data: { entityType: "order", entityId: returnReq.order } });
    res.json({ success: true, message: "Return approved", data: returnReq });
});

// Reject a return request (pending → rejected)
router.put("/:returnId/reject", async (req, res) => {
    const { note = "" } = req.body;
    const returnReq = await ReturnRequest.findOne({ _id: req.params.returnId, seller: req.seller._id });
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });
    if (returnReq.status !== "pending") return res.status(400).json({ success: false, message: `Cannot reject in "${returnReq.status}" status` });

    returnReq.status = "rejected";
    returnReq.sellerNote = note;
    returnReq.statusHistory.push({ status: "rejected", note, changedBy: req.user._id });
    await returnReq.save();

    await Notification.create({ recipient: returnReq.customer, type: "return_requested", title: "Return Rejected", message: `Your return was rejected. ${note}`, data: { entityType: "order", entityId: returnReq.order } });
    res.json({ success: true, message: "Return rejected", data: returnReq });
});

// Mark return as received and restore stock
router.put("/:returnId/receive", async (req, res) => {
    const returnReq = await ReturnRequest.findOne({ _id: req.params.returnId, seller: req.seller._id });
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });
    if (!["approved", "return_shipped"].includes(returnReq.status)) return res.status(400).json({ success: false, message: `Cannot receive in "${returnReq.status}" status` });

    returnReq.status = "return_received";
    returnReq.statusHistory.push({ status: "return_received", changedBy: req.user._id });
    await returnReq.save();

    for (const item of returnReq.items) {
      if (item.variant) await Variant.findByIdAndUpdate(item.variant, { $inc: { stock: item.quantity } });
    }

    await Order.findByIdAndUpdate(returnReq.order, { status: "return_received" });
    res.json({ success: true, message: "Return item received", data: returnReq });
});

export default router;
