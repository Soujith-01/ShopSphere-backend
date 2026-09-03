import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    actorRole: {
      type: String,
      enum: ["customer", "seller", "admin", "support", "delivery", "system"],
      required: true,
    },
    action: { type: String, required: true }, // e.g., "order.status_changed", "product.created"

    entityType: {
      type: String,
      enum: [
        "user",
        "seller",
        "store",
        "product",
        "category",
        "order",
        "parent_order",
        "review",
        "return",
        "coupon",
        "ticket",
        "notification",
      ],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    // Change tracking
    previousValues: { type: mongoose.Schema.Types.Mixed },
    newValues: { type: mongoose.Schema.Types.Mixed },

    // Context
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },

    description: { type: String, default: "" },
  },
  { timestamps: true }
);

auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ action: 1 });
auditLogSchema.index({ createdAt: -1 }, { expireAfterSeconds: 7776000 }); // Auto-delete after 90 days

const AuditLog = mongoose.model("AuditLog", auditLogSchema);
export default AuditLog;
