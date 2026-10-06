import Razorpay from "razorpay";
import crypto from "crypto";

/**
 * Lazily initialize Razorpay client so imports do not fail if env vars
 * are configured during runtime or tests.
 */
export const getRazorpayInstance = () => {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error(
      "Razorpay credentials missing. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env"
    );
  }

  return new Razorpay({
    key_id,
    key_secret,
  });
};

/**
 * Create a new Razorpay Order.
 *
 * @param {Object} options
 * @param {number} options.amount - Order amount in Indian Rupees (₹). Converted to paise (1 INR = 100 paise).
 * @param {string} [options.currency="INR"] - Currency code (default: INR)
 * @param {string} [options.receipt] - Internal receipt identifier
 * @param {Object} [options.notes] - Key-value metadata attached to the Razorpay order
 * @returns {Promise<Object>} Created Razorpay Order
 */
export const createRazorpayOrder = async ({
  amount,
  currency = "INR",
  receipt,
  notes = {},
}) => {
  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error("Invalid order amount. Amount must be greater than 0");
  }

  // Convert INR rupees to paise (e.g. ₹499.50 -> 49950 paise)
  const amountInPaise = Math.round(numAmount * 100);
  const rcpt = receipt || `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const key_id = process.env.RAZORPAY_KEY_ID || "";

  // If using placeholder / mock keys in development, simulate Razorpay order directly
  if (key_id.includes("YourKeyIdHere") || key_id.startsWith("rzp_test_mock") || process.env.RAZORPAY_MOCK === "true") {
    return {
      id: `order_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`,
      entity: "order",
      amount: amountInPaise,
      amount_paid: 0,
      amount_due: amountInPaise,
      currency,
      receipt: rcpt,
      status: "created",
      attempts: 0,
      notes,
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  try {
    const razorpay = getRazorpayInstance();
    const orderOptions = {
      amount: amountInPaise,
      currency,
      receipt: rcpt,
      notes: notes || {},
    };

    const razorpayOrder = await razorpay.orders.create(orderOptions);
    return razorpayOrder;
  } catch (err) {
    if (process.env.NODE_ENV !== "production" && (err.statusCode === 401 || err.message?.includes("authentication") || err.error?.description?.includes("Unauthorized"))) {
      console.warn("⚠️ [Razorpay Dev Fallback] Live Razorpay API rejected test key, using simulated Razorpay Order ID for test mode.");
      return {
        id: `order_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`,
        entity: "order",
        amount: amountInPaise,
        amount_paid: 0,
        amount_due: amountInPaise,
        currency,
        receipt: rcpt,
        status: "created",
        attempts: 0,
        notes,
        created_at: Math.floor(Date.now() / 1000),
      };
    }
    throw err;
  }
};

/**
 * Verifies Razorpay payment signature using HMAC SHA256.
 *
 * Formula: HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, secret) == razorpay_signature
 *
 * @param {Object} params
 * @param {string} params.razorpayOrderId
 * @param {string} params.razorpayPaymentId
 * @param {string} params.razorpaySignature
 * @returns {boolean} True if signature is valid, false otherwise
 */
export const verifyRazorpaySignature = ({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) => {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return false;
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    throw new Error("RAZORPAY_KEY_SECRET is not configured in environment");
  }

  const payload = `${razorpayOrderId}|${razorpayPaymentId}`;
  const generatedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(payload)
    .digest("hex");

  try {
    const signatureBuffer = Buffer.from(razorpaySignature, "utf8");
    const generatedBuffer = Buffer.from(generatedSignature, "utf8");

    if (signatureBuffer.length !== generatedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(signatureBuffer, generatedBuffer);
  } catch {
    return false;
  }
};

/**
 * Fetch payment details directly from Razorpay API.
 *
 * @param {string} paymentId - Razorpay payment ID (pay_xxx)
 * @returns {Promise<Object>} Razorpay payment entity
 */
export const getRazorpayPayment = async (paymentId) => {
  if (!paymentId) {
    throw new Error("Razorpay paymentId is required");
  }
  const razorpay = getRazorpayInstance();
  return razorpay.payments.fetch(paymentId);
};

/**
 * Fetch order details directly from Razorpay API.
 *
 * @param {string} orderId - Razorpay order ID (order_xxx)
 * @returns {Promise<Object>} Razorpay order entity
 */
export const getRazorpayOrder = async (orderId) => {
  if (!orderId) {
    throw new Error("Razorpay orderId is required");
  }
  const razorpay = getRazorpayInstance();
  return razorpay.orders.fetch(orderId);
};

/**
 * Get the public Razorpay Key ID (safe to share with client).
 *
 * @returns {string}
 */
export const getRazorpayKeyId = () => {
  return process.env.RAZORPAY_KEY_ID || "";
};

export default {
  getRazorpayInstance,
  createRazorpayOrder,
  verifyRazorpaySignature,
  getRazorpayPayment,
  getRazorpayOrder,
  getRazorpayKeyId,
};
