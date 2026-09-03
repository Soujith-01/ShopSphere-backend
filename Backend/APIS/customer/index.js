import { Router } from "express";
import products from "./products.js";
import categories from "./categories.js";
import cart from "./cart.js";
import wishlist from "./wishlist.js";
import orders from "./orders.js";
import reviews from "./reviews.js";
import coupons from "./coupons.js";
import users from "./users.js";
import notifications from "./notifications.js";
import support from "./support.js";

const router = Router();

router.use("/products", products);
router.use("/categories", categories);
router.use("/cart", cart);
router.use("/wishlist", wishlist);
router.use("/orders", orders);
router.use("/reviews", reviews);
router.use("/coupons", coupons);
router.use("/users", users);
router.use("/notifications", notifications);
router.use("/support", support);

export default router;
