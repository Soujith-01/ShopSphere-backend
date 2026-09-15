import { Router } from "express";
import ReturnRequest from "../../models/ReturnRequest.js";
import Order from "../../models/Order.js";
import Variant from "../../models/Variant.js";
import Product from "../../models/Product.js";
import Wallet from "../../models/Wallet.js";
import WalletTransaction from "../../models/WalletTransaction.js";
import Seller from "../../models/Seller.js";
import Notification from "../../models/Notification.js";
import { assignRandomDeliveryAgentForReturn } from "../../services/returnDeliveryAssignment.js";
import { syncProductToSheet } from "../../services/sheetSync.js";
import { syncOrderToSheet } from "../../services/sheetOrders.js";

const router = Router();

// List all return requests for this seller
router.get("/", async (req, res) => {
    const { page = 1, limit = 20, status } = req.query;
    const filter = { $or: [{ seller: req.seller._id }, { seller: req.user._id }] };
    if (status) filter.status = status;

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const [returns, total] = await Promise.all([
      ReturnRequest.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
        .populate("customer", "name email phone").populate("order", "orderNumber shippingAddress")
        .populate("product", "name slug images")
        .populate("deliveryPartner", "name phone email deliveryPartner.vehicleType").lean(),
      ReturnRequest.countDocuments(filter),
    ]);

    res.json({ success: true, data: returns, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } });
});

// Approve a return request (pending → approved) and assign delivery partner
router.put("/:returnId/approve", async (req, res) => {
    const { note = "" } = req.body;
    const returnReq = await ReturnRequest.findOne({
      _id: req.params.returnId,
      $or: [{ seller: req.seller._id }, { seller: req.user._id }],
    });
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });
    if (returnReq.status !== "pending") return res.status(400).json({ success: false, message: `Cannot approve in "${returnReq.status}" status` });

    returnReq.status = "approved";
    returnReq.sellerNote = note;
    returnReq.statusHistory.push({ status: "approved", note, changedBy: req.user._id });

    const order = await Order.findById(returnReq.order);
    if (order) {
      order.status = "return_approved";
      order.statusHistory.push({ status: "return_approved", note: `Return approved by seller. ${note}`.trim(), changedBy: req.user._id });
    }

    // Assign an on-duty delivery partner to pick up from customer
    const assignedAgent = await assignRandomDeliveryAgentForReturn(returnReq, order);
    await returnReq.save();
    if (order) await order.save();

    // Order moved to return_approved — keep the seller's Orders tab in step
    if (order) await syncOrderToSheet(order);

    await Notification.create({
      recipient: returnReq.customer,
      type: "return_approved",
      title: "Return Approved",
      message: assignedAgent
        ? `Your return has been approved! Delivery agent ${assignedAgent.name || ''} has been assigned to pick up the item.`
        : "Your return has been approved! A delivery partner will pick up the item.",
      data: { entityType: "return", entityId: returnReq._id },
    });

    res.json({
      success: true,
      message: `Return approved${assignedAgent ? " and delivery agent assigned for pickup" : ""}`,
      data: returnReq,
    });
});

// Reject a return request (pending → rejected)
router.put("/:returnId/reject", async (req, res) => {
    const { note = "" } = req.body;
    const returnReq = await ReturnRequest.findOne({
      _id: req.params.returnId,
      $or: [{ seller: req.seller._id }, { seller: req.user._id }],
    });
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });
    if (returnReq.status !== "pending") return res.status(400).json({ success: false, message: `Cannot reject in "${returnReq.status}" status` });

    returnReq.status = "rejected";
    returnReq.sellerNote = note;
    returnReq.statusHistory.push({ status: "rejected", note, changedBy: req.user._id });
    await returnReq.save();

    // Return withdrawn → restore the order to delivered (it was return_requested)
    const order = await Order.findById(returnReq.order);
    if (order && order.status === "return_requested") {
      order.status = "delivered";
      order.statusHistory.push({ status: "delivered", note: `Return rejected by seller. ${note}`.trim(), changedBy: req.user._id });
      await order.save();

      // Return withdrawn → back to delivered in the seller's Orders tab
      await syncOrderToSheet(order);
    }

    await Notification.create({ recipient: returnReq.customer, type: "return_rejected", title: "Return Rejected", message: `Your return was rejected. ${note}`.trim(), data: { entityType: "return", entityId: returnReq._id } });
    res.json({ success: true, message: "Return rejected", data: returnReq });
});

// Mark return as received, restore stock, and process the refund to the customer
router.put("/:returnId/receive", async (req, res) => {
    const returnReq = await ReturnRequest.findOne({
      _id: req.params.returnId,
      $or: [{ seller: req.seller._id }, { seller: req.user._id }],
    });
    if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });
    if (!["approved", "picked_up", "return_shipped", "returned_to_store"].includes(returnReq.status)) {
      return res.status(400).json({ success: false, message: `Cannot receive in "${returnReq.status}" status` });
    }

    returnReq.status = "return_received";
    returnReq.statusHistory.push({ status: "return_received", changedBy: req.user._id });
    await returnReq.save();

    // Restore stock for items (stock was deducted at checkout)
    const restoredProducts = new Set();

    for (const item of returnReq.items) {
      if (item.variant) {
        await Variant.findByIdAndUpdate(item.variant, { $inc: { stock: item.quantity } });
      } else if (item.product) {
        await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.quantity, "stats.totalSold": -item.quantity } });
      }

      if (item.product) restoredProducts.add(String(item.product));
    }

    // Mirror the returned stock back into each product's sheet. syncProductToSheet
    // re-reads the product + variants and records the reconciliation baseline, so
    // the next import doesn't mistake the restored stock for a seller edit.
    for (const productId of restoredProducts) {
      await syncProductToSheet(productId);
    }

    // ─── Refund the customer ─────────────────────────────────────────────
    // The seller was credited (order total − commission) in payments/verify (online)
    // or will be settled for COD; either way the platform debits the seller wallet
    // for the item value and records a refund transaction.
    const order = await Order.findById(returnReq.order);
    const sellerDoc = await Seller.findById(req.seller._id);

    if (order) {
      order.status = "return_received";
      order.statusHistory.push({ status: "return_received", note: "Return item received by seller", changedBy: req.user._id });
      order.payment.status = "refunded";
      order.payment.refundedAt = new Date();
      await order.save();

      // orderStatus (return_received) + paymentStatus (refunded) in the Orders tab
      await syncOrderToSheet(order);

      // Debit the seller wallet and record the refund transaction
      if (sellerDoc && order.total > 0) {
        const commissionPercent = sellerDoc.commissionRate || 5;
        const refundAmount = Math.round(order.total * (1 - commissionPercent / 100));

        let wallet = await Wallet.findOne({ seller: sellerDoc._id });
        if (!wallet) {
          wallet = await Wallet.create({ seller: sellerDoc._id, balance: 0, totalEarned: 0, totalWithdrawn: 0 });
        }
        wallet.balance = Math.max(0, wallet.balance - refundAmount);
        wallet.totalEarned = Math.max(0, (wallet.totalEarned || 0) - refundAmount);
        await wallet.save();

        await WalletTransaction.create({
          seller: sellerDoc._id,
          parentOrder: order.parentOrder || null,
          order: order._id,
          grossAmount: order.total,
          platformFee: order.total - refundAmount,
          sellerAmount: refundAmount,
          transactionType: "refund",
          status: "completed",
          description: `Refund for returned item — order ${order.orderNumber}`,
        });

        returnReq.refund = {
          amount: refundAmount,
          method: "original",
          processedAt: new Date(),
        };
        returnReq.status = "refunded";
        returnReq.statusHistory.push({ status: "refunded", note: `Refund of ₹${refundAmount} processed to seller wallet for customer credit`, changedBy: req.user._id });
        await returnReq.save();
      }

      // Notify customer that the refund has been processed
      await Notification.create({ recipient: returnReq.customer, type: "refund_processed", title: "Refund Processed", message: `Your return for order ${order.orderNumber} was received and a refund of ₹${returnReq.refund?.amount ?? order.total} has been processed.`, data: { entityType: "return", entityId: returnReq._id } });
    }

    res.json({ success: true, message: "Return item received and refund processed", data: returnReq });
});

export default router;
