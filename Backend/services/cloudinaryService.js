import cloudinary, { isCloudinaryConfigured } from "../config/cloudinary.js";

/**
 * Product-photo storage on Cloudinary.
 *
 * Sellers never type image URLs: the browser posts the file to the API, this
 * service streams it to Cloudinary, and only `secure_url` + `public_id` are
 * written into MongoDB (`Product.images`). No image bytes are ever stored in
 * MongoDB, and the Cloudinary API secret never leaves the server.
 *
 * Every asset lives under one folder so deletions can be scoped: a public id
 * outside this folder is never destroyed, which makes it impossible to wipe
 * another project's / another seller's asset with a crafted request.
 */
export const PRODUCT_IMAGE_FOLDER = "shopsphere/products";

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

export const ALLOWED_IMAGE_FORMATS = ["jpg", "jpeg", "png", "webp"];

// Keep in sync with Frontend (ImageEditorPicker MAX_UPLOAD_BYTES).
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_PRODUCT = 10;

export { isCloudinaryConfigured };

/** True only for assets this app owns (i.e. safe to delete). */
export const isManagedPublicId = (publicId) =>
  typeof publicId === "string" && publicId.startsWith(`${PRODUCT_IMAGE_FOLDER}/`);

/**
 * Stream an in-memory file buffer to Cloudinary.
 *
 * The upload transformation caps the stored asset at 1600px on its longest edge
 * and lets Cloudinary pick the quality — the frontend already downscales, and
 * this is the safety net for direct API calls from large phone photos.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{url: string, publicId: string, width?: number, height?: number}>}
 */
export function uploadImageBuffer(buffer, { folder = PRODUCT_IMAGE_FOLDER } = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        allowed_formats: ALLOWED_IMAGE_FORMATS,
        transformation: [
          { width: 1600, height: 1600, crop: "limit" },
          { quality: "auto:good" },
        ],
      },
      (error, result) => {
        if (error || !result?.secure_url) {
          const message = error?.message || "Cloudinary upload failed";
          console.error("⚠️ [Cloudinary] Upload failed:", message);
          reject(new Error("Image upload failed — please try again."));
          return;
        }

        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
        });
      }
    );

    stream.end(buffer);
  });
}

/**
 * Delete one Cloudinary asset. Best-effort by design: a failure here must never
 * fail the seller's product update (the row is already saved, and a leftover
 * asset only wastes storage).
 *
 * @returns {Promise<boolean>} true when the asset was removed
 */
export async function destroyImage(publicId) {
  if (!isManagedPublicId(publicId)) return false;

  try {
    // Cloudinary answers 200 with `result: "not found"` for a publicId that is
    // already gone, so the response body decides success — not the lack of a throw.
    const response = await cloudinary.uploader.destroy(publicId, { invalidate: true });

    if (response?.result === "ok") return true;

    if (response?.result === "not found") {
      console.warn(`⚠️ [Cloudinary] ${publicId} was already deleted`);
      return false;
    }

    console.error(`⚠️ [Cloudinary] Unexpected delete result for ${publicId}:`, response?.result);
    return false;
  } catch (error) {
    const message = error?.message || error;
    console.error(`⚠️ [Cloudinary] Could not delete ${publicId}: ${message}`);
    return false;
  }
}

/**
 * Delete several assets (removed photos, or uploads that were never saved).
 * @returns {Promise<number>} how many were actually removed
 */
export async function discardImages(publicIds = []) {
  const managed = [...new Set(publicIds.filter(isManagedPublicId))];
  if (managed.length === 0) return 0;

  const results = await Promise.all(managed.map((publicId) => destroyImage(publicId)));
  const removed = results.filter(Boolean).length;

  if (removed) {
    console.log(`🧹 [Cloudinary] Removed ${removed} unused product image(s)`);
  }

  return removed;
}

/**
 * Normalise the image list sent by the client into the `Product.images` shape.
 * The array order IS the display order (index 0 = cover), so `sortOrder` is
 * derived here and never trusted from the client.
 *
 * @param {Array<object>} rawImages
 * @param {object} [options]
 * @param {string} [options.altFallback] alt text used when the client sends none
 * @returns {Array<{url: string, publicId: string, alt: string, sortOrder: number}>}
 */
export function normalizeImages(rawImages, { altFallback = "" } = {}) {
  if (!Array.isArray(rawImages)) return [];

  return rawImages
    .map((image, index) => {
      // Only real remote URLs — drops `data:`/`blob:` payloads and stray text.
      const url = String(image?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return null;

      return {
        url,
        publicId: typeof image?.publicId === "string" ? image.publicId.trim() : "",
        alt: String(image?.alt || "").trim() || altFallback,
        sortOrder: index,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_IMAGES_PER_PRODUCT);
}

/** Cloudinary public ids of a product's images (used to find removed photos). */
export const publicIdsOf = (images = []) =>
  (images || []).map((image) => image?.publicId).filter(Boolean);

export default {
  PRODUCT_IMAGE_FOLDER,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_IMAGE_FORMATS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PRODUCT,
  uploadImageBuffer,
  destroyImage,
  discardImages,
  normalizeImages,
  publicIdsOf,
  isManagedPublicId,
};
