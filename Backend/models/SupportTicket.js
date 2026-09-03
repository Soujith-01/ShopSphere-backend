import mongoose from "mongoose";

const ticketMessageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    senderRole: {
      type: String,
      enum: ["customer", "support", "seller", "admin"],
      required: true,
    },
    message: { type: String, required: true },
    attachments: [
      {
        url: { type: String },
        publicId: { type: String },
      },
    ],
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const supportTicketSchema = new mongoose.Schema(
  {
    // Ticket info
    ticketNumber: { type: String, required: true, unique: true },
    subject: { type: String, required: true },

    // Who created it
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Related entities
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null,
    },

    // Category
    category: {
      type: String,
      enum: [
        "order_issue",
        "payment",
        "return",
        "refund",
        "product_query",
        "delivery",
        "account",
        "other",
      ],
      required: true,
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },

    status: {
      type: String,
      enum: ["open", "in_progress", "waiting_customer", "resolved", "closed"],
      default: "open",
    },

    // Assigned support agent
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Messages thread
    messages: [ticketMessageSchema],

    // Resolution
    resolution: { type: String, default: "" },
    resolvedAt: { type: Date, default: null },

    // Satisfaction rating
    satisfactionRating: { type: Number, min: 1, max: 5, default: null },
  },
  { timestamps: true }
);

supportTicketSchema.index({ customer: 1, createdAt: -1 });
supportTicketSchema.index({ assignedTo: 1, status: 1 });
supportTicketSchema.index({ ticketNumber: 1 });
supportTicketSchema.index({ status: 1, priority: -1 });

const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);
export default SupportTicket;
