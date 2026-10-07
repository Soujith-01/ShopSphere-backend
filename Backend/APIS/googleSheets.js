import express from "express";

import {
  getAuthorizationUrl,
  saveToken,
  testSheetsConnection,
  addProductToSheet
} from "../services/googleSheetsServices.js";


const router = express.Router();

function resolveRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI;
  }
  if (process.env.BACKEND_URL) {
    return `${process.env.BACKEND_URL.replace(/\/$/, "")}/api/google/callback`;
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/api/google/callback`;
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  if (host && !host.includes("localhost") && !host.includes("127.0.0.1")) {
    return `${proto}://${host}/api/google/callback`;
  }
  return null;
}

// Start Google OAuth
router.get("/auth", (req, res) => {
  try {
    const redirectUri = resolveRedirectUri(req);
    const url = getAuthorizationUrl(redirectUri);

    res.redirect(url);
  } catch (error) {
    console.error("OAuth URL Error:", error);
    res.status(500).json({
      message: "Failed to generate Google authorization URL",
      error: error.message
    });
  }
});

// Google OAuth callback
router.get("/callback", async (req, res) => {
  try {
    const { code, error } = req.query;

    if (error) {
      return res.status(400).send(`
        <div style="font-family: sans-serif; max-width: 650px; margin: 40px auto; padding: 24px; border: 1px solid #f5c6cb; border-radius: 8px; background: #fff;">
          <h2 style="color: #721c24; margin-top: 0;">Google Authorization Denied ❌</h2>
          <p style="color: #d32f2f;"><strong>Error:</strong> ${error}</p>
        </div>
      `);
    }

    if (!code) {
      return res.status(400).send("Authorization code missing");
    }

    const redirectUri = resolveRedirectUri(req);
    const tokens = await saveToken(code, redirectUri);

    console.log("✅ [Google Sheets] New OAuth Token Generated Successfully");

    res.send(`
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 680px; margin: 40px auto; padding: 28px; border: 1px solid #c3e6cb; border-radius: 10px; background: #ffffff; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
        <h2 style="color: #155724; margin-top: 0; display: flex; align-items: center; gap: 8px;">
          Google Sheets Connected Successfully! ✅
        </h2>
        <p style="color: #2e7d32; font-size: 15px; margin-bottom: 20px;">
          Your Google OAuth refresh token has been generated and saved.
        </p>

        <div style="background: #fff8e1; border-left: 4px solid #ffb300; padding: 14px 18px; margin: 20px 0; border-radius: 4px; color: #5d4037; font-size: 14px; line-height: 1.5;">
          <strong style="color: #bf360c;">⚡ Crucial for Render / Cloud Hosting:</strong><br/>
          Cloud containers (like Render) have <em>ephemeral disk storage</em>, meaning local files are erased on restart or spin-down. To make this token permanent:
          <ol style="margin: 8px 0 0 16px; padding: 0;">
            <li>Copy the JSON text from the box below.</li>
            <li>Go to your <strong>Render Dashboard → ShopSphere-backend → Environment</strong>.</li>
            <li>Add/update the environment variable: <code>GOOGLE_TOKEN_JSON</code></li>
            <li>Paste this JSON string as its value and click <strong>Save Changes</strong>.</li>
          </ol>
        </div>

        <label style="font-weight: 600; font-size: 13px; color: #374151; display: block; margin-bottom: 6px;">GOOGLE_TOKEN_JSON Value:</label>
        <textarea readonly onclick="this.select()" style="width: 100%; height: 160px; font-family: 'Courier New', Courier, monospace; font-size: 12px; padding: 12px; border-radius: 6px; border: 1px solid #cbd5e1; box-sizing: border-box; background: #f8fafc; color: #0f172a; resize: vertical;">${JSON.stringify(tokens, null, 2)}</textarea>
        
        <p style="color: #64748b; font-size: 13px; margin-top: 18px;">
          Once you have updated Render's environment variables, you can safely close this window.
        </p>
      </div>
    `);
  } catch (error) {
    console.error("OAuth Callback Error:", error);

    const redirectUri = resolveRedirectUri(req) || `https://${req.get("host")}/api/google/callback`;

    res.status(500).send(`
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 680px; margin: 40px auto; padding: 28px; border: 1px solid #f5c6cb; border-radius: 10px; background: #ffffff; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
        <h2 style="color: #721c24; margin-top: 0;">Google Sheets Connection Failed ❌</h2>
        <p style="color: #d32f2f; font-size: 15px;"><strong>Error:</strong> ${error.message}</p>
        
        <div style="background: #fdf2f2; border-left: 4px solid #f87171; padding: 14px 18px; border-radius: 4px; color: #991b1b; font-size: 14px; margin-top: 20px; line-height: 1.5;">
          <strong>How to fix this:</strong>
          <ul style="margin: 8px 0 0 16px; padding: 0;">
            <li style="margin-bottom: 6px;"><strong>If "redirect_uri_mismatch":</strong> Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color: #1d4ed8; text-decoration: underline;">Google Cloud Console Credentials</a>, edit your OAuth 2.0 Client ID, and add <code>${redirectUri}</code> to <strong>Authorized redirect URIs</strong>.</li>
            <li><strong>If "invalid_grant":</strong> The authorization code expired or was used already. <a href="/api/google/auth" style="color: #1d4ed8; text-decoration: underline;">Click here to retry authentication</a>.</li>
          </ul>
        </div>
      </div>
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