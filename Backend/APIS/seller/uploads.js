import { Router } from "express";
import {
  isCloudinaryConfigured,
  uploadImageBuffer,
} from "../../services/cloudinaryService.js";
import {
  imageUploadErrors,
  uploadAnyImages,
  uploadManyImages,
} from "../../middlewares/imageUpload.js";

/**
 * Generic seller image uploads.
 *
 * These routes are kept for backwards compatibility (store logo/banner and any
 * older client). New product photos go to POST /api/seller/products/upload-image,
 * which validates JPG/JPEG/PNG/WEBP and has the same response contract.
 *
 * Both routers are mounted behind `protect` + `requireSeller`, so only an
 * authenticated, verified seller can upload — and the file is streamed straight
 * to Cloudinary, never through MongoDB.
 */
const router = Router();

const NOT_CONFIGURED_MESSAGE =
  "Image uploads are not configured yet — add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to Backend/.env";

const uploadAll = async (files) =>
  Promise.all(
    files.map(async (file) => {
      const result = await uploadImageBuffer(file.buffer);
      return { url: result.url, publicId: result.publicId };
    })
  );

// Upload one or many images.
// - a single file in the "image" field  → { success: true, data: { url, publicId } }
// - anything else                        → { success: true, data: [{ url, publicId }, …] }
router.post("/", uploadAnyImages, imageUploadErrors, async (req, res, next) => {
  try {
    const files = req.files || (req.file ? [req.file] : []);

    if (files.length === 0) {
      return res.status(400).json({ success: false, message: "No image file uploaded" });
    }
    if (!isCloudinaryConfigured) {
      return res.status(503).json({ success: false, message: NOT_CONFIGURED_MESSAGE });
    }

    const uploaded = await uploadAll(files);

    if (uploaded.length === 1 && files[0].fieldname === "image") {
      return res.status(201).json({ success: true, data: uploaded[0] });
    }

    res.status(201).json({ success: true, data: uploaded });
  } catch (err) {
    next(err);
  }
});

// Batch upload — the "images" field, up to MAX_IMAGES_PER_PRODUCT files.
router.post("/multiple", uploadManyImages, imageUploadErrors, async (req, res, next) => {
  try {
    const files = req.files || [];

    if (files.length === 0) {
      return res.status(400).json({ success: false, message: "No image files uploaded" });
    }
    if (!isCloudinaryConfigured) {
      return res.status(503).json({ success: false, message: NOT_CONFIGURED_MESSAGE });
    }

    res.status(201).json({ success: true, data: await uploadAll(files) });
  } catch (err) {
    next(err);
  }
});

export default router;
