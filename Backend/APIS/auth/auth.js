import { Router } from "express";
import { body } from "express-validator";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../../models/User.js";
import Seller from "../../models/Seller.js";
import {
  generateAccessToken,
  generateRefreshToken,
  setTokenCookies,
} from "../../utils/tokenUtils.js";
import { protect } from "../../middlewares/authMiddleware.js";
import { validate } from "../../middlewares/validateMiddleware.js";

const router = Router();

// Register a new account — customers and sellers sign up here.
// Sellers additionally get a Seller profile (unverified until an admin verifies them),
// after which the frontend can render the seller dashboard based on user.role.
router.post(
  "/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
    body("role").optional().isIn(["customer", "seller"]).withMessage("Role must be 'customer' or 'seller'"),
    body("businessName")
      .if(body("role").equals("seller"))
      .trim()
      .notEmpty()
      .withMessage("businessName is required for seller registration")
      .isLength({ max: 100 })
      .withMessage("businessName must be at most 100 characters"),
    body("businessType")
      .optional()
      .isIn(["individual", "partnership", "private_ltd", "llp"])
      .withMessage("businessType must be individual, partnership, private_ltd or llp"),
  ],
  validate,
  async (req, res) => {
      const { name, email, password, role = "customer", businessName, businessType } = req.body;

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ success: false, message: "Email already registered" });
      }

      // Public register allows customers + sellers only (admin/delivery/support are staff roles)
      const userRole = role === "seller" ? "seller" : "customer";

      const user = await User.create({ name, email, password, role: userRole });

      // Sellers get a Seller profile immediately. If that fails, roll back the user
      // so we never leave an orphaned account behind.
      if (userRole === "seller") {
        try {
          await Seller.create({
            user: user._id,
            businessName: businessName.trim(),
            businessType: businessType || "individual",
          });
        } catch (err) {
          await User.deleteOne({ _id: user._id });
          throw err;
        }
      }

      const accessToken = generateAccessToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      user.refreshToken = refreshToken;
      await user.save({ validateModifiedOnly: true });

      setTokenCookies(res, accessToken, refreshToken);

      res.status(201).json({
        success: true,
        message: "Registration successful",
        data: { user, accessToken },
      });
  }
);

// Login with email and password
router.post(
  "/login",
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  validate,
  async (req, res) => {
      const { email, password } = req.body;

      const user = await User.findOne({ email }).select("+password");
      if (!user) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      if (!user.password) {
        return res.status(400).json({
          success: false,
          message: "Account uses Google login. Please sign in with Google.",
        });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      if (!user.isActive) {
        return res.status(403).json({ success: false, message: "Account deactivated" });
      }

      const accessToken = generateAccessToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      user.refreshToken = refreshToken;
      await user.save({ validateModifiedOnly: true });

      setTokenCookies(res, accessToken, refreshToken);

      res.json({
        success: true,
        message: "Login successful",
        data: { user, accessToken },
      });
  }
);

// Logout — clear tokens and revoke refresh token
router.post("/logout", protect, async (req, res) => {
    await User.findByIdAndUpdate(req.user._id, { refreshToken: null });

    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");

    res.json({ success: true, message: "Logged out" });
});

// Refresh access token using refresh token from cookie or body
router.post("/refresh", async (req, res) => {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;
    if (!token) {
      return res.status(401).json({ success: false, message: "No refresh token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || user.refreshToken !== token) {
      return res.status(401).json({ success: false, message: "Invalid refresh token" });
    }

    const newAccessToken = generateAccessToken(user._id);
    const newRefreshToken = generateRefreshToken(user._id);

    user.refreshToken = newRefreshToken;
    await user.save({ validateModifiedOnly: true });

    setTokenCookies(res, newAccessToken, newRefreshToken);

    res.json({
      success: true,
      data: { accessToken: newAccessToken },
    });
});

// Google OAuth login or register
router.post("/google", async (req, res) => {
    const { credential } = req.body;

    // Verify Google token
    const { OAuth2Client } = await import("google-auth-library");
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const { sub: googleId, email, name, picture } = ticket.getPayload();

    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (user) {
      user.googleId = googleId;
      if (picture && !user.avatar.url) {
        user.avatar = { url: picture, publicId: "" };
      }
      await user.save({ validateModifiedOnly: true });
    } else {
      user = await User.create({
        name,
        email,
        googleId,
        avatar: { url: picture || "", publicId: "" },
        isEmailVerified: true,
        role: "customer",
      });
    }

    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    user.refreshToken = refreshToken;
    await user.save({ validateModifiedOnly: true });

    setTokenCookies(res, accessToken, refreshToken);

    res.json({
      success: true,
      message: "Google auth successful",
      data: { user, accessToken },
    });
});

// Forgot password — generates a reset token (in production, sends email)
router.post(
  "/forgot-password",
  [body("email").isEmail().withMessage("Valid email is required")],
  validate,
  async (req, res) => {
      const user = await User.findOne({ email: req.body.email });
      if (!user) {
        return res.json({
          success: true,
          message: "If email exists, a reset link has been sent",
        });
      }

      const resetToken = crypto.randomBytes(32).toString("hex");
      user.passwordResetToken = crypto.createHash("sha256").update(resetToken).digest("hex");
      user.passwordResetExpires = Date.now() + 60 * 60 * 1000; // 1 hour
      await user.save({ validateModifiedOnly: true });

      // TODO: Send email with resetToken in production

      res.json({
        success: true,
        message: "If email exists, a reset link has been sent",
        ...(process.env.NODE_ENV !== "production" && { resetToken }),
      });
  }
);

// Reset password using token from email
router.put(
  "/reset-password/:token",
  [body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters")],
  validate,
  async (req, res) => {
      const hashedToken = crypto.createHash("sha256").update(req.params.token).digest("hex");

      const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() },
      });

      if (!user) {
        return res.status(400).json({ success: false, message: "Invalid or expired reset token" });
      }

      user.password = req.body.password;
      user.passwordResetToken = null;
      user.passwordResetExpires = null;
      user.refreshToken = null;
      await user.save();

      const accessToken = generateAccessToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      user.refreshToken = refreshToken;
      await user.save({ validateModifiedOnly: true });

      setTokenCookies(res, accessToken, refreshToken);

      res.json({
        success: true,
        message: "Password reset successful",
        data: { user, accessToken },
      });
  }
);

// Get current authenticated user's profile
router.get("/me", protect, async (req, res) => {
    const user = await User.findById(req.user._id).select("-password -refreshToken");
    res.json({ success: true, data: user });
});

export default router;
