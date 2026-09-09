import { Router } from "express";
import { body } from "express-validator";
import { protect } from "../../middlewares/authMiddleware.js";
import { validate } from "../../middlewares/validateMiddleware.js";
import ReturnRequest from "../../models/ReturnRequest.js";
import Order from "../../models/Order.js";
import Product from "../../models/Product.js";
import Seller from "../../models/Seller.js";
import Notification from "../../models/Notification.js";

const router = Router();
router.use(protect);

// GET /api/customer/returns — list the customer's return requests
router.get("/", async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const filter = { customer: req.user._id };
  if (status) filter.status = status;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Math.max(1, Number(limit)));

  const [returns, total] = await Promise.all([
    ReturnRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("order", "orderNumber")
      .populate("product", "name slug images")
      .populate("seller", "businessName")
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

// GET /api/customer/returns/:returnId — single return detail
router.get("/:returnId", async (req, res) => {
  const ret = await ReturnRequest.findOne({
    _id: req.params.returnId,
    customer: req.user._id,
  })
    .populate("order", "orderNumber")
    .populate("product", "name slug images")
    .populate("seller", "businessName")
    .lean();

  if (!ret) {
    return res
      .status(404)
      .json({ success: false, message: "Return request not found" });
  }

  res.json({ success: true, data: ret });
});

// POST /api/customer/returns — create a return request
router.post(
  "/",
  [
    body("orderId").isMongoId().withMessage("orderId must be a valid ObjectId"),
    body("productId")
      .isMongoId()
      .withMessage("productId must be a valid ObjectId"),
    body("reason")
      .isIn([
        "defective",
        "wrong_item",
        "not_as_described",
        "damaged",
        "size_issue",
        "changed_mind",
        "other",
      ])
      .withMessage("Invalid return reason"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 1000 })
      .withMessage("Description must be at most 1000 characters"),
    body("quantity")
      .optional()
      .isInt({ min: 1 })
      .withMessage("quantity must be >= 1"),
  ],
  validate,
  async (req, res) => {
    const { orderId, productId, reason, description = "", quantity } = req.body;

    // Verify the order belongs to this customer and was delivered
    const order = await Order.findOne({
      _id: orderId,
      customer: req.user._id,
      status: "delivered",
    });

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Return can only be requested for delivered orders",
      });
    }

    // Verify the product is in this order
    const orderItem = order.items.find(
      (item) => String(item.product) === String(productId)
    );
    if (!orderItem) {
      return res.status(400).json({
        success: false,
        message: "Product not found in this order",
      });
    }

    // Prevent duplicate return requests for the same product+order
    const existing = await ReturnRequest.findOne({
      order: orderId,
      customer: req.user._id,
      product: productId,
      status: { $nin: ["rejected", "refunded"] },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "A return request already exists for this product",
      });
    }

    // Find the product to get seller info
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const returnQty = Math.min(
      quantity || orderItem.quantity,
      orderItem.quantity
    );

    const returnRequest = await ReturnRequest.create({
      order: orderId,
      customer: req.user._id,
      seller: product.seller,
      product: productId,
      items: [
        {
          product: productId,
          variant: orderItem.variant || null,
          productName: orderItem.productName,
          quantity: returnQty,
          reason,
        },
      ],
      reason,
      description,
      statusHistory: [
        {
          status: "pending",
          note: "Return request created by customer",
          changedBy: req.user._id,
        },
      ],
    });

    // Notify seller
    await Notification.create({
      recipient: product.seller,
      type: "return_requested",
      title: "Return Requested",
      message: `A customer requested a return for "${product.name}" (${reason})`,
      data: { entityType: "return", entityId: returnRequest._id },
    });

    res.status(201).json({
      success: true,
      message: "Return request submitted",
      data: returnRequest,
    });
  }
);

export default router;
