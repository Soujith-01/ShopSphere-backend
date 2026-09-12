import { Router } from "express";
import ReturnRequest from "../../models/ReturnRequest.js";
import Order from "../../models/Order.js";

const router = Router();

// Return analytics / counts for admin
router.get("/stats", async (req, res) => {
    const [totalReturns, pending, approved, pickedUp, returnedToStore, received, rejected, totalRefundAggregate] = await Promise.all([
        ReturnRequest.countDocuments(),
        ReturnRequest.countDocuments({ status: "pending" }),
        ReturnRequest.countDocuments({ status: "approved" }),
        ReturnRequest.countDocuments({ status: "picked_up" }),
        ReturnRequest.countDocuments({ status: "returned_to_store" }),
        ReturnRequest.countDocuments({ status: { $in: ["received", "return_received", "refunded"] } }),
        ReturnRequest.countDocuments({ status: "rejected" }),
        ReturnRequest.aggregate([
            { $match: { status: { $in: ["received", "return_received", "refunded"] }, "refund.status": "completed" } },
            { $group: { _id: null, total: { $sum: "$refund.amount" } } },
        ]),
    ]);

    res.json({
        success: true,
        data: {
            totalReturns,
            pending,
            approved,
            pickedUp,
            returnedToStore,
            received,
            rejected,
            totalRefundAmount: totalRefundAggregate[0]?.total || 0,
        },
    });
});

// List all return requests across platform
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, status, search, sellerId } = req.query;
    const filter = {};

    if (status && status !== "all") {
        filter.status = status;
    }
    if (sellerId) {
        filter.seller = sellerId;
    }

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    // If search is provided, find matching order IDs first
    if (search && search.trim()) {
        const matchingOrders = await Order.find({
            orderNumber: { $regex: search.trim(), $options: "i" },
        }).select("_id").lean();
        const orderIds = matchingOrders.map(o => o._id);

        filter.$or = [
            { order: { $in: orderIds } },
            { reason: { $regex: search.trim(), $options: "i" } },
            { comments: { $regex: search.trim(), $options: "i" } },
        ];
    }

    const [returns, total] = await Promise.all([
        ReturnRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .populate("customer", "name email phone")
            .populate("seller", "businessName storeName phone email")
            .populate("order", "orderNumber shippingAddress total payment")
            .populate("product", "title name images price")
            .populate("deliveryPartner", "name phone email")
            .lean(),
        ReturnRequest.countDocuments(filter),
    ]);

    res.json({
        success: true,
        data: returns,
        pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            pages: Math.ceil(total / limitNum),
        },
    });
});

// Get single return request
router.get("/:returnId", async (req, res) => {
    const returnReq = await ReturnRequest.findById(req.params.returnId)
        .populate("customer", "name email phone address")
        .populate("seller", "businessName storeName phone email address")
        .populate("order", "orderNumber shippingAddress total items payment")
        .populate("product", "title name images price sku")
        .populate("deliveryPartner", "name phone email deliveryPartner")
        .populate("statusHistory.changedBy", "name email role");

    if (!returnReq) {
        return res.status(404).json({ success: false, message: "Return request not found" });
    }

    res.json({ success: true, data: returnReq });
});

export default router;
