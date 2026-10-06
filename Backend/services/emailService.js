import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const {
    EMAIL_SERVICE,
    EMAIL_HOST,
    EMAIL_PORT,
    EMAIL_USER,
    EMAIL_PASS,
  } = process.env;

  if (EMAIL_SERVICE || EMAIL_HOST) {
    transporter = nodemailer.createTransport({
      service: EMAIL_SERVICE || undefined,
      host: EMAIL_HOST || undefined,
      port: EMAIL_PORT ? parseInt(EMAIL_PORT, 10) : (EMAIL_SERVICE ? undefined : 587),
      secure: EMAIL_PORT === "465",
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,
      },
    });
  }

  return transporter;
}

/**
 * Send an email directly to the seller with their Google Sheet link
 */
export async function sendStoreSheetEmail({ sellerEmail, sellerName, storeName, sheetUrl }) {
  if (!sellerEmail || !sheetUrl) {
    console.warn("⚠️ [Email Service] Missing seller email or sheet URL for sending notification.");
    return { success: false, reason: "Missing email or URL" };
  }

  const transport = getTransporter();
  const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_USER || "ShopSphere <no-reply@shopsphere.com>";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f6f8fa; margin: 0; padding: 20px; }
          .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
          .header { text-align: center; margin-bottom: 24px; }
          .logo { font-size: 28px; font-weight: 800; color: #111827; letter-spacing: -0.5px; }
          .logo span { color: #4f46e5; }
          h2 { color: #1f2937; margin-top: 0; font-size: 22px; }
          p { color: #4b5563; font-size: 15px; line-height: 1.6; }
          .btn-container { text-align: center; margin: 30px 0; }
          .btn { display: inline-block; background-color: #4f46e5; color: #ffffff !important; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; box-shadow: 0 2px 4px rgba(79, 70, 229, 0.3); }
          .info-box { background: #f3f4f6; border-left: 4px solid #4f46e5; padding: 14px 18px; border-radius: 6px; margin: 20px 0; font-size: 14px; color: #374151; }
          .footer { text-align: center; font-size: 13px; color: #9ca3af; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <div class="logo">Shop<span>Sphere</span></div>
          </div>
          <h2>Welcome, ${sellerName || "Seller"}! 🎉</h2>
          <p>Your store <strong>"${storeName || "My Store"}"</strong> is live, and your dedicated Google Sheet for inventory and order management is ready.</p>
          
          <div class="btn-container">
            <a href="${sheetUrl}" class="btn" target="_blank">📊 Open Your Google Sheet</a>
          </div>

          <div class="info-box">
            <strong>What you can do with your Google Sheet:</strong>
            <ul style="margin: 8px 0 0 0; padding-left: 20px;">
              <li>Add or edit products — changes automatically sync to your store</li>
              <li>Track real-time orders in the <strong>Orders</strong> tab</li>
              <li>Monitor live stock levels in the <strong>Inventory</strong> tab</li>
            </ul>
          </div>

          <p>Direct Link: <a href="${sheetUrl}">${sheetUrl}</a></p>

          <div class="footer">
            <p>© ${new Date().getFullYear()} ShopSphere Marketplace. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;

  if (!transport) {
    console.log(`📧 [Email Service - Preview] (Configure EMAIL_USER & EMAIL_PASS in .env to send live SMTP emails)`);
    console.log(`To: ${sellerEmail}`);
    console.log(`Subject: Your Google Sheet for ${storeName} is ready!`);
    console.log(`Sheet Link: ${sheetUrl}`);
    return { success: true, simulated: true };
  }

  try {
    const info = await transport.sendMail({
      from: fromAddress,
      to: sellerEmail,
      subject: `Your ShopSphere Google Sheet is ready — ${storeName}`,
      html: htmlContent,
      text: `Welcome! Your store "${storeName}" is live. Access your Google Sheet here: ${sheetUrl}`,
    });

    console.log(`✅ [Email Service] Sent Google Sheet email to ${sellerEmail}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ [Email Service] Failed to send email to ${sellerEmail}:`, error.message);
    return { success: false, error: error.message };
  }
}

export default {
  sendStoreSheetEmail,
};
