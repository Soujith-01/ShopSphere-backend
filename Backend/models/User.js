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
    isEmailVerified: { type: Boolean, default: false },

    // Token fields (rotated on login; used by /refresh and password reset)
    refreshToken: { type: String, default: null },
    passwordResetToken: { type: String, default: null },
    passwordResetExpires: { type: Date, default: null },

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

// Indexes (email index is auto-created by unique: true)
userSchema.index({ role: 1 });
userSchema.index({ "deliveryPartner.currentLocation": "2dsphere" });

// Hash password before saving
// Note: async middleware must NOT use next() — mongoose awaits the returned promise
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  this.password = await bcrypt.hash(this.password, 12);
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
