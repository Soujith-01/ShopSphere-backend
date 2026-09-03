import { Router } from "express";
import User from "../../models/User.js";
import { protect } from "../../middlewares/authMiddleware.js";

const router = Router();
router.use(protect);

// Get current user's profile
router.get("/me", async (req, res) => {
    const user = await User.findById(req.user._id).select("-password -refreshToken -passwordResetToken -passwordResetExpires");
    res.json({ success: true, data: user });
});

// Update profile (name, phone)
router.put("/me", async (req, res) => {
    const allowedFields = ["name", "phone"];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true }).select("-password -refreshToken");
    res.json({ success: true, message: "Profile updated", data: user });
});

// Add a new address
router.post("/me/addresses", async (req, res) => {
    const { label, fullName, phone, street, pincode, isDefault } = req.body;
    if (!fullName || !phone || !street || !pincode) {
      return res.status(400).json({ success: false, message: "fullName, phone, street, and pincode are required" });
    }

    const user = await User.findById(req.user._id);
    if (isDefault || user.addresses.length === 0) user.addresses.forEach((a) => (a.isDefault = false));

    user.addresses.push({ label: label || "Home", fullName, phone, street, pincode, isDefault: isDefault || user.addresses.length === 0 });
    await user.save({ validateModifiedOnly: true });

    const updatedUser = await User.findById(req.user._id).select("-password -refreshToken");
    res.status(201).json({ success: true, message: "Address added", data: updatedUser.addresses });
});

// Update an existing address
router.put("/me/addresses/:addressId", async (req, res) => {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: "Address not found" });

    const { label, fullName, phone, street, pincode, isDefault } = req.body;
    if (label !== undefined) address.label = label;
    if (fullName !== undefined) address.fullName = fullName;
    if (phone !== undefined) address.phone = phone;
    if (street !== undefined) address.street = street;
    if (pincode !== undefined) address.pincode = pincode;

    if (isDefault) { user.addresses.forEach((a) => (a.isDefault = false)); address.isDefault = true; }

    await user.save({ validateModifiedOnly: true });
    const updatedUser = await User.findById(req.user._id).select("-password -refreshToken");
    res.json({ success: true, message: "Address updated", data: updatedUser.addresses });
});

// Delete an address (reassigns default if needed)
router.delete("/me/addresses/:addressId", async (req, res) => {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: "Address not found" });

    const wasDefault = address.isDefault;
    address.deleteOne();
    if (wasDefault && user.addresses.length > 0) user.addresses[0].isDefault = true;

    await user.save({ validateModifiedOnly: true });
    const updatedUser = await User.findById(req.user._id).select("-password -refreshToken");
    res.json({ success: true, message: "Address deleted", data: updatedUser.addresses });
});

// Set an address as default
router.put("/me/addresses/:addressId/default", async (req, res) => {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: "Address not found" });

    user.addresses.forEach((a) => (a.isDefault = false));
    address.isDefault = true;

    await user.save({ validateModifiedOnly: true });
    const updatedUser = await User.findById(req.user._id).select("-password -refreshToken");
    res.json({ success: true, message: "Default address set", data: updatedUser.addresses });
});

export default router;
