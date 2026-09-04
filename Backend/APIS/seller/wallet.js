import { Router } from "express";
import mongoose from "mongoose";
import Wallet from "../../models/Wallet.js";
import WalletTransaction from "../../models/WalletTransaction.js";
import Withdrawal from "../../models/Withdrawal.js";

const router = Router();

// Minimum withdrawal amount (configurable via env)
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL_AMOUNT || "100");

// GET /api/seller/wallet
// Get the seller's wallet balance and summary stats.
router.get("/", async (req, res) => {
  let wallet = await Wallet.findOne({ seller: req.seller._id });

  // Auto-create wallet if it doesn't exist yet
  if (!wallet) {
    wallet = await Wallet.create({
      seller: req.seller._id,
      balance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
    });
  }

  // Get pending withdrawal total
  const pendingWithdrawals = await Withdrawal.aggregate([
    { $match: { seller: req.seller._id, status: { $in: ["pending", "approved"] } } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  const pendingAmount = pendingWithdrawals[0]?.total || 0;

  res.json({
    success: true,
    data: {
      balance: wallet.balance,
      totalEarned: wallet.totalEarned,
      totalWithdrawn: wallet.totalWithdrawn,
      pendingWithdrawals: pendingAmount,
      availableForWithdrawal: Math.max(0, wallet.balance - pendingAmount),
      minimumWithdrawal: MIN_WITHDRAWAL,
      currency: "INR",
    },
  });
});

// GET /api/seller/wallet/transactions
// Get wallet transaction history with pagination.
router.get("/transactions", async (req, res) => {
  const { page = 1, limit = 20, type } = req.query;
  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Math.max(1, Number(limit)));

  const filter = { seller: req.seller._id };
  if (type && ["credit", "debit", "withdrawal", "refund"].includes(type)) {
    filter.transactionType = type;
  }

  const [transactions, total] = await Promise.all([
    WalletTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("order", "orderNumber total")
      .populate("parentOrder", "total")
      .lean(),
    WalletTransaction.countDocuments(filter),
  ]);

  // Calculate running balance (newest first, so reverse for running total)
  let runningBalance = 0;
  const wallet = await Wallet.findOne({ seller: req.seller._id });
  if (wallet) runningBalance = wallet.balance;

  const enriched = transactions.map((txn) => {
    const entry = { ...txn };
    if (txn.transactionType === "credit" || txn.transactionType === "refund") {
      entry.balanceAfter = runningBalance;
      runningBalance -= txn.sellerAmount;
    } else {
      entry.balanceAfter = runningBalance;
      runningBalance += txn.sellerAmount;
    }
    return entry;
  });

  res.json({
    success: true,
    data: enriched,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
    },
  });
});

// POST /api/seller/wallet/withdraw
// Request a withdrawal from the seller's wallet.
router.post("/withdraw", async (req, res) => {
  const { amount, bankDetails } = req.body;

  // Validate amount
  const withdrawAmount = parseFloat(amount);
  if (!withdrawAmount || withdrawAmount <= 0) {
    return res.status(400).json({ success: false, message: "Valid withdrawal amount is required" });
  }
  if (withdrawAmount < MIN_WITHDRAWAL) {
    return res.status(400).json({
      success: false,
      message: `Minimum withdrawal amount is ₹${MIN_WITHDRAWAL}`,
    });
  }

  // Validate bank details
  if (!bankDetails || typeof bankDetails !== "object") {
    return res.status(400).json({ success: false, message: "Bank details are required" });
  }
  const { accountHolder, accountNumber, ifscCode, bankName = "" } = bankDetails;
  if (!accountHolder || !accountHolder.trim()) {
    return res.status(400).json({ success: false, message: "Account holder name is required" });
  }
  if (!accountNumber || !/^\d{9,18}$/.test(accountNumber.replace(/\s/g, ""))) {
    return res.status(400).json({ success: false, message: "Valid account number is required (9-18 digits)" });
  }
  if (!ifscCode || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode.toUpperCase())) {
    return res.status(400).json({ success: false, message: "Valid IFSC code is required (e.g., HDFC0001234)" });
  }

  // Get or create wallet
  let wallet = await Wallet.findOne({ seller: req.seller._id });
  if (!wallet) {
    wallet = await Wallet.create({
      seller: req.seller._id,
      balance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
    });
  }

  // Check pending withdrawal amount
  const pendingWithdrawals = await Withdrawal.aggregate([
    { $match: { seller: req.seller._id, status: { $in: ["pending", "approved"] } } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const pendingAmount = pendingWithdrawals[0]?.total || 0;
  const available = wallet.balance - pendingAmount;

  if (withdrawAmount > available) {
    return res.status(400).json({
      success: false,
      message: `Insufficient balance. Available: ₹${available.toFixed(2)}`,
    });
  }

  // Create withdrawal request
  const withdrawal = await Withdrawal.create({
    seller: req.seller._id,
    amount: withdrawAmount,
    status: "pending",
    bankDetails: {
      accountHolder: accountHolder.trim(),
      accountNumber: accountNumber.replace(/\s/g, ""),
      ifscCode: ifscCode.toUpperCase(),
      bankName: bankName.trim(),
    },
  });

  res.status(201).json({
    success: true,
    message: "Withdrawal request submitted successfully",
    data: {
      withdrawalId: withdrawal._id,
      amount: withdrawal.amount,
      status: withdrawal.status,
      bankDetails: {
        accountHolder: withdrawal.bankDetails.accountHolder,
        accountNumber: "****" + withdrawal.bankDetails.accountNumber.slice(-4),
        ifscCode: withdrawal.bankDetails.ifscCode,
        bankName: withdrawal.bankDetails.bankName,
      },
      createdAt: withdrawal.createdAt,
    },
  });
});

// GET /api/seller/wallet/withdrawals
// Get withdrawal history with pagination.
router.get("/withdrawals", async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Math.max(1, Number(limit)));

  const filter = { seller: req.seller._id };
  if (status && ["pending", "approved", "rejected", "paid"].includes(status)) {
    filter.status = status;
  }

  const [withdrawals, total] = await Promise.all([
    Withdrawal.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .select("-bankDetails.accountNumber") // Mask account number in list
      .lean(),
    Withdrawal.countDocuments(filter),
  ]);

  // Mask account numbers
  const masked = withdrawals.map((w) => ({
    ...w,
    bankDetails: w.bankDetails
      ? {
          ...w.bankDetails,
          accountNumber: "****" + w.bankDetails.accountNumber.slice(-4),
        }
      : w.bankDetails,
  }));

  res.json({
    success: true,
    data: masked,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
    },
  });
});

// GET /api/seller/wallet/withdrawals/:withdrawalId
// Get a single withdrawal detail (with masked account number).
router.get("/withdrawals/:withdrawalId", async (req, res) => {
  const { withdrawalId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(withdrawalId)) {
    return res.status(400).json({ success: false, message: "Invalid withdrawal ID" });
  }

  const withdrawal = await Withdrawal.findOne({
    _id: withdrawalId,
    seller: req.seller._id,
  }).lean();

  if (!withdrawal) {
    return res.status(404).json({ success: false, message: "Withdrawal not found" });
  }

  // Mask account number
  if (withdrawal.bankDetails) {
    withdrawal.bankDetails.accountNumber =
      "****" + withdrawal.bankDetails.accountNumber.slice(-4);
  }

  res.json({ success: true, data: withdrawal });
});

export default router;
