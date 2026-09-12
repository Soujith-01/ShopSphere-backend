import { Router } from "express";
import multer from "multer";
import cloudinary, { isCloudinaryConfigured } from "../../config/cloudinary.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// Helper to stream a memory buffer to Cloudinary
const uploadBufferToCloudinary = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "shopsphere/products" },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });

// Upload one or multiple product images to Cloudinary.
// Supports:
// - single file with fieldname "image" -> returns { success: true, data: { url, publicId } }
// - multiple files with fieldname "images" or multiple files -> returns { success: true, data: [{ url, publicId }, ...] }
router.post("/", upload.any(), async (req, res, next) => {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: "No image file uploaded" });
    }
    if (!isCloudinaryConfigured) {
      return res.status(503).json({
        success: false,
        message: "Image uploads are not configured yet — add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to Backend/.env",
      });
    }

    const uploaded = await Promise.all(
      files.map(async (f) => {
        const result = await uploadBufferToCloudinary(f.buffer);
        return { url: result.secure_url, publicId: result.public_id };
      })
    );

    // If caller specifically sent single "image", return single object for backwards compatibility
    if (files.length === 1 && files[0].fieldname === "image") {
      return res.status(201).json({
        success: true,
        data: uploaded[0],
      });
    }

    res.status(201).json({
      success: true,
      data: uploaded,
    });
  } catch (err) {
    next(err);
  }
});

// Dedicated batch upload endpoint for multiple images
router.post("/multiple", upload.array("images", 10), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: "No image files uploaded" });
    }
    if (!isCloudinaryConfigured) {
      return res.status(503).json({
        success: false,
        message: "Image uploads are not configured yet — add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to Backend/.env",
      });
    }

    const uploaded = await Promise.all(
      files.map(async (f) => {
        const result = await uploadBufferToCloudinary(f.buffer);
        return { url: result.secure_url, publicId: result.public_id };
      })
    );

    res.status(201).json({
      success: true,
      data: uploaded,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
