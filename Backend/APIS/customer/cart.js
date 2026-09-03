import { Router } from "express";
import Cart from "../../models/Cart.js";
import Product from "../../models/Product.js";
import Variant from "../../models/Variant.js";
import { protect } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect);

// Get user's cart with populated items
router.get("/", async (req, res) => {
  let cart = await Cart.findOne({ user: req.user._id })
    .populate("items.product", "name slug price images status")
    .populate("items.variant", "label price stock images");

  if (!cart) cart = await Cart.create({ user: req.user._id, items: [] });

  // Filter out unavailable products
  cart.items = cart.items.filter((item) => {
    if (!item.product || item.product.status !== "active") return false;
    if (item.variant && item.variant.stock <= 0) return false;
    return true;
  });

  cart.subtotal = cart.items.reduce((sum, item) => sum + item.priceAtAdd * item.quantity, 0);
  cart.totalItems = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  await cart.save();

  res.json({ success: true, data: cart });
});

// Add item to cart (with optional variant)
router.post("/", async (req, res) => {
  const { productId, variantId, quantity = 1 } = req.body;

  const product = await Product.findOne({ _id: productId, status: "active" });
  if (!product) return res.status(404).json({ success: false, message: "Product not found" });

  let price = product.price;
  let stock = Infinity;
  let variantDoc = null;
  let productImage = product.images?.[0]?.url || "";

  if (variantId) {
    variantDoc = await Variant.findOne({ _id: variantId, product: productId, isActive: true });
    if (!variantDoc) return res.status(404).json({ success: false, message: "Variant not found" });
    price = variantDoc.price;
    stock = variantDoc.availableStock;
    if (variantDoc.images?.length) productImage = variantDoc.images[0].url;
  } else if (product.hasVariants) {
    return res.status(400).json({ success: false, message: "This product has variants. Please select a variant." });
  }

  if (quantity > stock && stock !== Infinity) {
    return res.status(400).json({ success: false, message: "Insufficient stock" });
  }

  let cart = await Cart.findOne({ user: req.user._id });
  if (!cart) cart = new Cart({ user: req.user._id, items: [] });

  const existingIndex = cart.items.findIndex(
    (item) => item.product.toString() === productId &&
      (variantId ? item.variant?.toString() === variantId : !item.variant)
  );

  if (existingIndex > -1) {
    const newQty = cart.items[existingIndex].quantity + quantity;
    if (newQty > stock && stock !== Infinity) {
      return res.status(400).json({ success: false, message: "Insufficient stock" });
    }
    cart.items[existingIndex].quantity = newQty;
  } else {
    cart.items.push({
      product: productId, variant: variantId || null, priceAtAdd: price, quantity,
      productName: product.name, productImage, sellerId: product.seller, storeId: product.store, storeName: "",
    });
  }

  cart.subtotal = cart.items.reduce((sum, item) => sum + item.priceAtAdd * item.quantity, 0);
  cart.totalItems = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  await cart.save();

  cart = await Cart.findOne({ user: req.user._id })
    .populate("items.product", "name slug price images status")
    .populate("items.variant", "label price stock images");

  res.json({ success: true, message: "Item added to cart", data: cart });
});

// Update cart item quantity
router.put("/:itemId", async (req, res) => {
  const { quantity } = req.body;
  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart) return res.status(404).json({ success: false, message: "Cart not found" });

  const item = cart.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ success: false, message: "Item not found in cart" });

  if (quantity <= 0) {
    item.deleteOne();
  } else {
    if (item.variant) {
      const variant = await Variant.findById(item.variant);
      if (variant && quantity > variant.availableStock) {
        return res.status(400).json({ success: false, message: "Insufficient stock" });
      }
    }
    item.quantity = quantity;
  }

  cart.subtotal = cart.items.reduce((sum, i) => sum + i.priceAtAdd * i.quantity, 0);
  cart.totalItems = cart.items.reduce((sum, i) => sum + i.quantity, 0);
  await cart.save();

  const updatedCart = await Cart.findOne({ user: req.user._id })
    .populate("items.product", "name slug price images status")
    .populate("items.variant", "label price stock images");

  res.json({ success: true, data: updatedCart });
});

// Remove a single item from cart
router.delete("/:itemId", async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id });
  if (!cart) return res.status(404).json({ success: false, message: "Cart not found" });

  const item = cart.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ success: false, message: "Item not found in cart" });

  item.deleteOne();
  cart.subtotal = cart.items.reduce((sum, i) => sum + i.priceAtAdd * i.quantity, 0);
  cart.totalItems = cart.items.reduce((sum, i) => sum + i.quantity, 0);
  await cart.save();

  const updatedCart = await Cart.findOne({ user: req.user._id })
    .populate("items.product", "name slug price images status")
    .populate("items.variant", "label price stock images");

  res.json({ success: true, data: updatedCart });
});

// Clear entire cart
router.delete("/", async (req, res) => {
  await Cart.findOneAndUpdate(
    { user: req.user._id },
    { items: [], subtotal: 0, totalItems: 0, coupon: null, discountAmount: 0 }
  );
  res.json({ success: true, message: "Cart cleared" });
});

export default router;
