import { Router } from "express";
import { protect } from "../../middlewares/authMiddleware.js";
import { requireSeller } from "../../middlewares/sellerMiddleware.js";
import products from "./products.js";
import store from "./store.js";
import orders from "./orders.js";
import returns from "./returns.js";
import dashboard from "./dashboard.js";
import wallet from "./wallet.js";

const router = Router();
router.use(protect, requireSeller);

router.use("/products", products);
router.use("/store", store);
router.use("/orders", orders);
router.use("/returns", returns);
router.use("/dashboard", dashboard);
router.use("/wallet", wallet);

export default router;
