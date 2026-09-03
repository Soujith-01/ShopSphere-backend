import { Router } from "express";
import User from "../../models/User.js";
import { protect } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect);

// Get user's wishlist with populated product details
router.get("/", async (req, res) => {
    const user = await User.findById(req.user._id)
      .populate({ path: "wishlist", select: "name slug price images stats status",
        populate: [{ path: "category", select: "name slug" }, { path: "store", select: "name slug" }],
      });

    const wishlist = (user.wishlist || []).filter((p) => p && p.status === "active");
    res.json({ success: true, data: wishlist });
});

// Toggle product in/out of wishlist
router.post("/toggle", async (req, res) => {
    const { productId } = req.body;
    const user = await User.findById(req.user._id);
    const index = user.wishlist.indexOf(productId);

    let action;
    if (index > -1) { user.wishlist.splice(index, 1); action = "removed"; }
    else { user.wishlist.push(productId); action = "added"; }

    await user.save({ validateModifiedOnly: true });
    res.json({ success: true, message: `Product ${action} from wishlist`, data: { wishlist: user.wishlist, action } });
});

// Check if a product is in the user's wishlist
router.get("/check/:productId", async (req, res) => {
    const user = await User.findById(req.user._id).select("wishlist");
    const isWishlisted = user.wishlist.some((id) => id.toString() === req.params.productId);
    res.json({ success: true, data: { isWishlisted } });
});

export default router;
