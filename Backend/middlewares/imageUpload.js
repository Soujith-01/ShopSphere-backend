import multer from "multer";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PRODUCT,
} from "../services/cloudinaryService.js";

/**
 * Shared multipart handling for seller image uploads.
 *
 * Memory storage on purpose: the buffer is streamed straight to Cloudinary, so
 * nothing is written to disk and no image bytes ever reach MongoDB. Type and
 * size are validated here — before any upload starts — and multer's raw errors
 * are turned into the same `{ success, message }` shape the rest of the API uses.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_PRODUCT },
  fileFilter: (req, file, cb) => {
    const mimetype = String(file.mimetype || "").toLowerCase();

    if (ALLOWED_IMAGE_MIME_TYPES.includes(mimetype)) return cb(null, true);

    const error = new Error("Unsupported image type — please use a JPG, PNG or WEBP photo");
    error.code = "UNSUPPORTED_IMAGE_TYPE";
    error.statusCode = 415;
    cb(error);
  },
});

// Single upload — field name "image" (returns req.file).
export const uploadSingleImage = upload.single("image");

// Batch upload — field name "images", up to MAX_IMAGES_PER_PRODUCT files.
export const uploadManyImages = upload.array("images", MAX_IMAGES_PER_PRODUCT);

// Accepts any field name (kept for backwards compatibility with older clients).
export const uploadAnyImages = upload.any();

const megabytes = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

/**
 * Turn multer's errors into friendly API responses. Mount directly after the
 * multer middleware, e.g. `router.post("/", uploadSingleImage, imageUploadErrors, handler)`.
 */
export function imageUploadErrors(err, req, res, next) {
  if (!err) return next();

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: `That photo is too large — the limit is ${megabytes} MB. Try a smaller photo or use the crop & resize option.`,
    });
  }

  if (err.code === "LIMIT_FILE_COUNT") {
    return res.status(400).json({
      success: false,
      message: `You can upload up to ${MAX_IMAGES_PER_PRODUCT} photos at a time`,
    });
  }

  if (err.code === "UNSUPPORTED_IMAGE_TYPE") {
    return res.status(415).json({ success: false, message: err.message });
  }

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, message: err.message });
  }

  return next(err);
}

export default uploadSingleImage;
