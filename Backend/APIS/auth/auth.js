import { Router } from "express";
import { body } from "express-validator";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import multer from "multer";
import User from "../../models/User.js";
import Seller from "../../models/Seller.js";
import Notification from "../../models/Notification.js";
import cloudinary, { isCloudinaryConfigured } from "../../config/cloudinary.js";
import {
  generateAccessToken,
  generateRefreshToken,
  setTokenCookies,
} from "../../utils/tokenUtils.js";
import { protect } from "../../middlewares/authMiddleware.js";
import { validate } from "../../middlewares/validateMiddleware.js";

const router = Router();

// Accepts multipart/form-data so delivery agents can attach a driving-license
// photo at registration. JSON bodies pass through untouched (multer no-ops
// when the request isn't multipart), so customer/seller registration is unchanged.
const registerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed for the license photo"));
  },
});

// Multer throws plain Errors (e.g. non-image file, >8MB) which the global
// error handler would turn into a 500. Convert them to a clean 400 instead.
const parseRegisterUpload = (req, res, next) =>
  registerUpload.any()(req, res, (err) => {
    if (err) {
      const message = err.code === "LIMIT_FILE_SIZE"
        ? "License photo must be 8MB or smaller"
        : err.message || "Invalid license photo upload";
      return res.status(400).json({ success: false, message });
    }
    next();
  });

const uploadLicenseToCloudinary = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "shopsphere/delivery-licenses" },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });

// Register a new account — customers, sellers and delivery agents sign up here.
// Sellers get a Seller profile; delivery agents submit vehicle details + a
// driving-license photo. Neither gets a session on register: an approval request
// goes to the admins, and login stays blocked (403) until an admin approves them
// via PUT /api/admin/sellers/:sellerId/verify or /api/admin/delivery/:userId/verify.
router.post(
  "/register",
  parseRegisterUpload,
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
    body("role").optional().isIn(["customer", "seller", "delivery"]).withMessage("Role must be 'customer', 'seller' or 'delivery'"),
    body("phone")
      .if(body("role").equals("delivery"))
      .trim()
      .notEmpty()
      .withMessage("phone is required for delivery registration")
      .matches(/^[0-9+\-\s]{6,15}$/)
      .withMessage("phone must be a valid phone number"),
    body("vehicleType")
      .if(body("role").equals("delivery"))
      .trim()
      .notEmpty()
      .withMessage("vehicleType is required for delivery registration"),
    body("vehicleNumber")
      .if(body("role").equals("delivery"))
      .trim()
      .notEmpty()
      .withMessage("vehicleNumber is required for delivery registration")
      .isLength({ max: 20 })
      .withMessage("vehicleNumber must be at most 20 characters"),
    body("licenseNumber")
      .if(body("role").equals("delivery"))
      .trim()
      .notEmpty()
      .withMessage("licenseNumber is required for delivery registration")
      .isLength({ max: 30 })
      .withMessage("licenseNumber must be at most 30 characters"),
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
      const {
        name, email, password, role = "customer",
        businessName, businessType,
        phone, vehicleType, vehicleNumber, licenseNumber,
      } = req.body;

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ success: false, message: "Email already registered" });
      }

      // Public register allows customers + sellers + delivery agents only
      // (admin/support are staff roles with no public onboarding).
      const userRole = role === "seller" ? "seller" : role === "delivery" ? "delivery" : "customer";

      const user = await User.create({ name, email, password, role: userRole });

      // Sellers get a Seller profile immediately. If that fails, roll back the user
      // so we never leave an orphaned account behind.
      if (userRole === "seller") {
        try {
          const seller = await Seller.create({
            user: user._id,
            businessName: businessName.trim(),
            businessType: businessType || "individual",
          });

          // Approval request: notify every active admin so the application shows
          // up for review. The seller stays unverified (and can't log in) until an
          // admin approves them via PUT /api/admin/sellers/:sellerId/verify.
          const admins = await User.find({ role: "admin", isActive: true }).select("_id");
          if (admins.length > 0) {
            await Notification.create(
              admins.map((admin) => ({
                recipient: admin._id,
                type: "seller_pending_approval",
                title: "New Seller Approval Request",
                message: `"${businessName.trim()}" (${user.email}) registered as a seller and is awaiting your approval.`,
                data: { entityType: "seller", entityId: seller._id },
              }))
            );
          }
        } catch (err) {
          await User.deleteOne({ _id: user._id });
          throw err;
        }

        // Sellers do NOT get a session yet — login only works after admin approval.
        return res.status(201).json({
          success: true,
          message:
            "Registration successful. Your seller application has been sent for admin approval — you can log in once approved.",
          data: { user, requiresApproval: true },
        });
      }

      // Delivery agents register with vehicle details + a driving-license photo
      // and stay locked out of login until an admin verifies the documents via
      // PUT /api/admin/delivery/:userId/verify.
      if (userRole === "delivery") {
        const licenseFile = (req.files || []).find((f) => f.fieldname === "licensePhoto");
        if (!licenseFile) {
          await User.deleteOne({ _id: user._id });
          return res.status(400).json({
            success: false,
            message: "A driving license photo (licensePhoto field) is required for delivery registration",
          });
        }
        if (!isCloudinaryConfigured) {
          await User.deleteOne({ _id: user._id });
          return res.status(503).json({
            success: false,
            message: "Image uploads are not configured yet — add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to Backend/.env",
          });
        }

        try {
          const uploaded = await uploadLicenseToCloudinary(licenseFile.buffer);
          user.phone = phone.trim();
          user.deliveryPartner.vehicleType = vehicleType.trim();
          user.deliveryPartner.vehicleNumber = vehicleNumber.trim().toUpperCase();
          user.deliveryPartner.licenseNumber = licenseNumber.trim().toUpperCase();
          user.deliveryPartner.licensePhoto = { url: uploaded.secure_url, publicId: uploaded.public_id };
          user.deliveryPartner.verificationStatus = "pending";
          await user.save({ validateModifiedOnly: true });

          // Approval request → every active admin, mirroring the seller flow.
          const admins = await User.find({ role: "admin", isActive: true }).select("_id");
          if (admins.length > 0) {
            await Notification.create(
              admins.map((admin) => ({
                recipient: admin._id,
                type: "delivery_pending_approval",
                title: "New Delivery Agent Approval Request",
                message: `${user.name} (${user.email}) registered as a delivery agent with a ${vehicleType.trim()} and is awaiting document verification.`,
                data: { entityType: "user", entityId: user._id },
              }))
            );
          }
        } catch (err) {
          await User.deleteOne({ _id: user._id });
          // Corrupt/unsupported images make Cloudinary throw — give the agent a
          // clear 400 instead of a generic 500.
          if (err?.http_code) {
            return res.status(400).json({
              success: false,
              message: "Could not upload the license photo. Please make sure it's a valid image and try again.",
            });
          }
          throw err;
        }

        return res.status(201).json({
          success: true,
          message:
            "Registration successful. Your delivery partner application has been sent for admin verification — you can log in once approved.",
          data: { user, requiresApproval: true },
        });
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

      // Sellers can't log in until an admin approves their application.
      if (user.role === "seller") {
        const seller = await Seller.findOne({ user: user._id }).select("isVerified status");
        if (!seller) {
          return res.status(403).json({ success: false, message: "Seller profile not found for this account" });
        }
        if (!seller.isVerified) {
          const pending = seller.status === "rejected"
            ? "Your seller application was rejected by an admin. You cannot log in with this account."
            : "Your seller application is pending admin approval. You can log in once an admin approves it.";
          return res.status(403).json({ success: false, message: pending });
        }
      }

      // Delivery agents can't log in until an admin verifies their documents.
      if (user.role === "delivery") {
        if (user.deliveryPartner?.verificationStatus === "rejected") {
          return res.status(403).json({
            success: false,
            message: `Your delivery partner application was rejected. Reason: ${user.deliveryPartner.rejectionReason || "not specified"}`,
          });
        }
        if (user.deliveryPartner?.verificationStatus !== "approved") {
          return res.status(403).json({
            success: false,
            message: "Your delivery partner application is pending admin verification. You can log in once an admin approves your documents.",
          });
        }
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
      if (!user.isActive) {
        return res.status(403).json({ success: false, message: "Account deactivated" });
      }
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

// Request account reactivation — used by deactivated users who can't log in.
// Sends a notification to all active admins so they can review the request.
router.post(
  "/request-activation",
  [body("email").isEmail().withMessage("Valid email is required")],
  validate,
  async (req, res) => {
      const { email } = req.body;
      const user = await User.findOne({ email: email.toLowerCase().trim() });
      if (!user) {
        // Don't reveal whether the email exists
        return res.json({ success: true, message: "If your account is deactivated, a reactivation request has been sent to our admin team." });
      }
      if (user.isActive) {
        return res.json({ success: true, message: "Your account is already active. You can log in normally." });
      }

      // Only notify admins once per request cycle — if the user already asked
      // recently (within 24h), don't spam every admin again. Still respond OK.
      const alreadyRequested =
        user.activationRequestedAt &&
        Date.now() - new Date(user.activationRequestedAt).getTime() < 24 * 60 * 60 * 1000;

      if (!alreadyRequested) {
        user.activationRequestedAt = new Date();
        await user.save({ validateModifiedOnly: true });

        // Notify all active admins about the reactivation request
        const admins = await User.find({ role: "admin", isActive: true }).select("_id");
        if (admins.length > 0) {
          await Notification.create(
            admins.map((admin) => ({
              recipient: admin._id,
              type: "activation_request",
              title: "Account Reactivation Request",
              message: `User "${user.name}" (${user.email}) has requested account reactivation. Please review and activate their account if appropriate.`,
              data: { entityType: "user", entityId: user._id },
            }))
          );
        }
      }

      res.json({ success: true, message: "Your reactivation request has been sent to our admin team. You'll be notified once it's reviewed." });
  }
);

export default router;
