// Live Cloudinary round-trip check for the product-photo pipeline.
//
//   cd Backend && node scripts/test-image-upload.js
//
// Builds a tiny (4×4) PNG in memory — no fixture files, and it verifies the PNG
// is well-formed before uploading — then runs exactly what the API runs:
//
//   upload (services/cloudinaryService.js)  →  fetch the delivered URL
//   destroy the asset                       →  fetch again (should be gone)
//
// The temporary asset is deleted in the same run, so nothing is left behind.
// Needs CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in Backend/.env.
import "dotenv/config";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

import cloudinary from "../config/cloudinary.js";
import {
  PRODUCT_IMAGE_FOLDER,
  destroyImage,
  isCloudinaryConfigured,
  uploadImageBuffer,
} from "../services/cloudinaryService.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ─── Minimal PNG encoder (so the test needs no binary fixture) ──────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, "ascii");

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
};

export function buildTestPng(width = 4, height = 4) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour RGB
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = 108; // ShopSphere purple
      raw[pixel + 1] = 62;
      raw[pixel + 2] = 242;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Prove the fixture is a real PNG before blaming Cloudinary for anything.
function assertValidPng(buffer, width, height) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("bad PNG signature");

  const declaredWidth = buffer.readUInt32BE(16);
  const declaredHeight = buffer.readUInt32BE(20);
  if (declaredWidth !== width || declaredHeight !== height) {
    throw new Error(`bad PNG dimensions ${declaredWidth}×${declaredHeight}`);
  }

  // IHDR = 8 signature + 4 length + 4 type; IDAT data starts after IHDR + its CRC.
  const idatLength = buffer.readUInt32BE(8 + 25);
  const idatType = buffer.toString("ascii", 8 + 29, 8 + 33);
  if (idatType !== "IDAT") throw new Error(`expected IDAT, found ${idatType}`);

  const inflated = zlib.inflateSync(buffer.subarray(8 + 33, 8 + 33 + idatLength));
  const expected = height * (1 + width * 3);
  if (inflated.length !== expected) {
    throw new Error(`IDAT inflated to ${inflated.length} bytes, expected ${expected}`);
  }

  return { width: declaredWidth, height: declaredHeight, bytes: buffer.length };
}

const headStatus = async (url) => {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status;
  } catch (error) {
    return `network error: ${error.message}`;
  }
};

async function main() {
  if (!isCloudinaryConfigured) {
    console.error(
      "❌ Cloudinary is not configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in Backend/.env"
    );
    process.exit(1);
  }

  const png = buildTestPng(4, 4);
  const fixture = assertValidPng(png, 4, 4);
  console.log(`🧪 Test fixture: valid ${fixture.width}×${fixture.height} PNG (${fixture.bytes} bytes)`);

  // A delete is only meaningful for assets in our own folder.
  console.log(`🚫 Guard: a foreign publicId must be refused → ${await destroyImage("some-other-project/photo")}`);

  console.log(`⬆️  Uploading to ${PRODUCT_IMAGE_FOLDER}/ …`);
  const uploaded = await uploadImageBuffer(png);

  console.log("✅ Uploaded");
  console.log("   url      :", uploaded.url);
  console.log("   publicId :", uploaded.publicId);

  let failed = false;

  if (!uploaded.url.startsWith("https://")) {
    console.error("❌ Expected an https Cloudinary URL");
    failed = true;
  }
  if (!uploaded.publicId.startsWith(`${PRODUCT_IMAGE_FOLDER}/`)) {
    console.error(`❌ Expected the publicId to live under ${PRODUCT_IMAGE_FOLDER}/`);
    failed = true;
  }

  const liveStatus = await headStatus(uploaded.url);
  console.log(`🌐 GET the uploaded URL → ${liveStatus}${liveStatus === 200 ? " (asset is live)" : ""}`);
  if (liveStatus !== 200) failed = true;

  console.log("🗑️  Deleting the test asset …");
  const deleted = await destroyImage(uploaded.publicId);
  console.log(deleted ? "✅ Deleted" : "❌ Delete failed");

  if (!deleted) {
    failed = true;
  } else {
    // The CDN can keep a cached copy of the image for a little while, so confirm
    // the deletion through the Admin API instead of a URL fetch.
    const stillExists = await cloudinary.api
      .resource(uploaded.publicId)
      .then(() => true)
      .catch(() => false);

    console.log(stillExists ? "❌ Asset still exists in Cloudinary" : "✅ Confirmed gone from Cloudinary");
    if (stillExists) failed = true;

    const afterStatus = await headStatus(uploaded.url);
    console.log(`🌐 GET the URL again → ${afterStatus}${afterStatus === 404 ? " (purged)" : " (CDN cache — harmless)"}`);
  }

  console.log(failed ? "\n❌ Round trip FAILED" : "\n✅ Upload → deliver → delete round trip OK");
  process.exit(failed ? 1 : 0);
}

// Run only when executed directly — importing this file must have no side
// effects (it would upload an asset to the caller's Cloudinary account).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error("❌ FAILED:", error.message);
    process.exit(1);
  });
}

export { main };
