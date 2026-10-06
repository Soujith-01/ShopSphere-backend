import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  verifyRazorpaySignature,
  getRazorpayKeyId,
} from "../services/razorpayService.js";

describe("Razorpay Service — Signature & Amount Verification", () => {
  const mockSecret = "test_razorpay_secret_123456";

  // Set test env
  process.env.RAZORPAY_KEY_SECRET = mockSecret;
  process.env.RAZORPAY_KEY_ID = "rzp_test_mockKey123";

  it("getRazorpayKeyId returns configured public key ID", () => {
    assert.equal(getRazorpayKeyId(), "rzp_test_mockKey123");
  });

  it("verifyRazorpaySignature returns true for valid HMAC SHA256 signature", () => {
    const orderId = "order_test_123456";
    const paymentId = "pay_test_789012";
    const expectedSignature = crypto
      .createHmac("sha256", mockSecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const isValid = verifyRazorpaySignature({
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: expectedSignature,
    });

    assert.equal(isValid, true);
  });

  it("verifyRazorpaySignature returns false for tampered signature", () => {
    const orderId = "order_test_123456";
    const paymentId = "pay_test_789012";
    const fakeSignature = "invalid_tampered_signature_hex_value_1234567890abcdef";

    const isValid = verifyRazorpaySignature({
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: fakeSignature,
    });

    assert.equal(isValid, false);
  });

  it("verifyRazorpaySignature returns false for altered paymentId", () => {
    const orderId = "order_test_123456";
    const paymentId = "pay_test_789012";
    const validSignature = crypto
      .createHmac("sha256", mockSecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const isValid = verifyRazorpaySignature({
      razorpayOrderId: orderId,
      razorpayPaymentId: "pay_test_altered_999999",
      razorpaySignature: validSignature,
    });

    assert.equal(isValid, false);
  });

  it("verifyRazorpaySignature returns false for altered orderId", () => {
    const orderId = "order_test_123456";
    const paymentId = "pay_test_789012";
    const validSignature = crypto
      .createHmac("sha256", mockSecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const isValid = verifyRazorpaySignature({
      razorpayOrderId: "order_test_tampered_999999",
      razorpayPaymentId: paymentId,
      razorpaySignature: validSignature,
    });

    assert.equal(isValid, false);
  });

  it("verifyRazorpaySignature returns false for empty or missing arguments", () => {
    assert.equal(
      verifyRazorpaySignature({
        razorpayOrderId: "",
        razorpayPaymentId: "pay_123",
        razorpaySignature: "sig_123",
      }),
      false
    );
    assert.equal(
      verifyRazorpaySignature({
        razorpayOrderId: "order_123",
        razorpayPaymentId: "",
        razorpaySignature: "sig_123",
      }),
      false
    );
    assert.equal(
      verifyRazorpaySignature({
        razorpayOrderId: "order_123",
        razorpayPaymentId: "pay_123",
        razorpaySignature: "",
      }),
      false
    );
  });

  it("correctly calculates paise from rupees (₹1 = 100 paise, ₹499.50 = 49950 paise)", () => {
    const toPaise = (rupees) => Math.round(Number(rupees) * 100);
    assert.equal(toPaise(100), 10000);
    assert.equal(toPaise(499.5), 49950);
    assert.equal(toPaise(0.99), 99);
    assert.equal(toPaise(1499), 149900);
  });
});
