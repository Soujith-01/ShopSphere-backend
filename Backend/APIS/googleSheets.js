import express from "express";

import {
  getAuthorizationUrl,
  saveToken,
  testSheetsConnection,
  addProductToSheet
} from "../services/googleSheetsServices.js";


const router = express.Router();

// Start Google OAuth
router.get("/auth", (req, res) => {
  try {
    const url = getAuthorizationUrl();

    res.redirect(url);
  } catch (error) {
    console.error("OAuth URL Error:", error);
    res.status(500).json({
      message: "Failed to generate Google authorization URL"
    });
  }
});

// Google OAuth callback
router.get("/callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send("Authorization code missing");
    }

    await saveToken(code);

    res.send(`
      <h2>Google Sheets Connected Successfully! ✅</h2>
      <p>You can close this tab.</p>
    `);
  } catch (error) {
    console.error("OAuth Callback Error:", error);

    res.status(500).send(`
      <h2>Google Sheets Connection Failed ❌</h2>
      <p>${error.message}</p>
    `);
  }
});

// Test connection
router.get("/test", async (req, res) => {
  try {
    const spreadsheetName = await testSheetsConnection();

    res.json({
      success: true,
      message: "Google Sheets connection successful",
      spreadsheet: spreadsheetName
    });
  } catch (error) {
    console.error("Sheets Test Error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.post("/test-product", async (req, res) => {
  try {
    const product = req.body;

    const result = await addProductToSheet(product);

    res.json({
      success: true,
      message: "Product added to Google Sheets successfully",
      result
    });
  } catch (error) {
    console.error("Add Product Error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

export default router;