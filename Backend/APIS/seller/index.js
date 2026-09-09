import { Router } from "express";
import { protect } from "../../middlewares/authMiddleware.js";
import { requireSeller } from "../../middlewares/sellerMiddleware.js";
import products from "./products.js";
import store from "./store.js";
import orders from "./orders.js";
import returns from "./returns.js";
import dashboard from "./dashboard.js";
import wallet from "./wallet.js";
import notifications from "./notifications.js";
import uploads from "./uploads.js";
import messages from "./messages.js";

const router = Router();
router.use(protect, requireSeller);

router.use("/products", products);
router.use("/store", store);
router.use("/orders", orders);
router.use("/returns", returns);
router.use("/dashboard", dashboard);
router.use("/wallet", wallet);
router.use("/notifications", notifications);
router.use("/uploads", uploads);
router.use("/messages", messages);

export default router;
