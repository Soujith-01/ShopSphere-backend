// Creates (or promotes) a support-agent account so you can log into the
// support dashboard. Safe to re-run: an existing agent with the same email is
// left untouched; an existing customer with that email is promoted to support.
//
// Usage (from Backend/):  node scripts/seed-support-agent.js
// Credentials come from SUPPORT_AGENT_EMAIL / SUPPORT_AGENT_PASSWORD env vars,
// falling back to the defaults printed at the end.
import mongoose from "mongoose";
import { config } from "dotenv";
import User from "../models/User.js";

config();

const EMAIL = (process.env.SUPPORT_AGENT_EMAIL || "support@shopsphere.test").toLowerCase();
const PASSWORD = process.env.SUPPORT_AGENT_PASSWORD || "support123";
const NAME = process.env.SUPPORT_AGENT_NAME || "Support Agent";

const seed = async () => {
  const uri = process.env.MONGODB_URI || process.env.DB_URL;
  if (!uri) {
    console.error("No MONGODB_URI / DB_URL found in Backend/.env — cannot connect.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected to MongoDB — seeding support agent…");

  let user = await User.findOne({ email: EMAIL }).select("+password");

  if (user && user.role === "support") {
    console.log(`  exists: ${EMAIL} is already a support agent.`);
  } else if (user) {
    user.role = "support";
    await user.save({ validateModifiedOnly: true });
    console.log(`  promoted: ${EMAIL} (${user.role} → support).`);
  } else {
    user = await User.create({ name: NAME, email: EMAIL, password: PASSWORD, role: "support" });
    console.log(`  created: ${EMAIL} (role: support).`);
  }

  user.password = PASSWORD;
  await user.save({ validateModifiedOnly: true });

  console.log("\nSupport agent login credentials:");
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);

  await mongoose.disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
