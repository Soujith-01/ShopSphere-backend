import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, default: "Home" },
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    street: { type: String, required: true },
    pincode: { type: String, required: true },
  },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: function () {
        return !this.googleId;
      },
      minlength: 6,
    },
    phone: { type: String, default: "" },
    avatar: {
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
    },

    // Multi-role: customer is default, others are assigned
    role: {
      type: String,
      enum: ["customer", "seller", "admin", "support", "delivery"],
      default: "customer",
    },

    // Google OAuth
    googleId: { type: String, default: null },

    // Addresses for shipping/billing
    addresses: [addressSchema],

    // Wishlist (simple array of product refs)
    wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],

    // Account status
    isActive: { type: Boolean, default: true },

    // Delivery partner specific
    deliveryPartner: {
      isAvailable: { type: Boolean, default: false },
      currentLocation: {
        type: { type: String, enum: ["Point"], default: "Point" },
        coordinates: { type: [Number], default: [0, 0] },
      },
      vehicleType: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

// Indexes
userSchema.index({ email: 1 });
userSchema.index({ role: 1 });
userSchema.index({ "deliveryPartner.currentLocation": "2dsphere" });

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  delete obj.emailVerificationToken;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  return obj;
};

const User = mongoose.model("User", userSchema);
export default User;
