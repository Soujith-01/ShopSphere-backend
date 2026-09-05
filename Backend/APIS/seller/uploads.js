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

// Upload one product image to Cloudinary, returns { url, publicId } to store
// on the Product/Variant image schema.
router.post("/", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file uploaded" });
    }
    if (!isCloudinaryConfigured) {
      return res.status(503).json({
        success: false,
        message: "Image uploads are not configured yet — add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to Backend/.env",
      });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "shopsphere/products" },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    res.status(201).json({
      success: true,
      data: { url: result.secure_url, publicId: result.public_id },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
