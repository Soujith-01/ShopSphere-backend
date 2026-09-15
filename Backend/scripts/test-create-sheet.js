import { testGoogleIdentity } from "../services/googleSheetsServices.js";

async function test() {
  try {
    const result = await testGoogleIdentity();

    console.log("✅ OAuth account:");
    console.log(result);
  } catch (error) {
    console.error("❌ FAILED");
    console.error(error?.response?.data || error.message);
  }
}

test();