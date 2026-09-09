import { Router } from "express";
import { protect, authorize } from "../../middlewares/authMiddleware.js";
import users from "./users.js";
import sellers from "./sellers.js";
import products from "./products.js";
import categories from "./categories.js";
import coupons from "./coupons.js";
import orders from "./orders.js";
import analytics from "./analytics.js";
import notifications from "./notifications.js";

const router = Router();
router.use(protect, authorize("admin"));

router.use("/users", users);
router.use("/sellers", sellers);
router.use("/products", products);
router.use("/categories", categories);
router.use("/coupons", coupons);
router.use("/orders", orders);
router.use("/analytics", analytics);
router.use("/notifications", notifications);

export default router;
