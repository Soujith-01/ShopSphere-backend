import Seller from "../models/Seller.js";

// Ensure user is an approved seller and attach seller doc to req
export const requireSeller = async (req, res, next) => {
  try {
    const seller = await Seller.findOne({ user: req.user._id });
    if (!seller) {
      return res.status(403).json({
        success: false,
        message: "You are not registered as a seller",
      });
    }
    if (!seller.isVerified) {
      return res.status(403).json({
        success: false,
        message:
          seller.status === "rejected"
            ? "Your seller application was rejected"
            : "Your seller application is pending admin approval",
      });
    }
    if (!seller.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your seller account is deactivated",
      });
    }
    req.seller = seller;
    next();
  } catch (err) {
    next(err);
  }
};

// Ensure seller owns this product/store
export const checkOwnership = (Model, field = "seller") => {
  return async (req, res, next) => {
    try {
      const doc = await Model.findById(req.params.id);
      if (!doc) {
        return res.status(404).json({ success: false, message: "Resource not found" });
      }
      if (doc[field].toString() !== req.seller._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You do not own this resource",
        });
      }
      req.resource = doc;
      next();
    } catch (err) {
      next(err);
    }
  };
};
