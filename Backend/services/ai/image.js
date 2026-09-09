// ---------------------------------------------------------------------------
// Fetch a product image from its URL and turn it into Gemini inline data
// ({ mimeType, data: base64 }). The seller form stores Cloudinary URLs, so the
// backend fetches the bytes itself — the browser never has to send a big blob.
//
// Fully graceful: any failure (bad URL, timeout, non-image, too large) returns
// null and the caller falls back to text-only generation.
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — generous for a 1600px product photo
const IMAGE_FETCH_TIMEOUT_MS = 10000;

export async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") return null;
  try {
    const url = new URL(imageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;

    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;

    return { mimeType: contentType || "image/jpeg", data: buffer.toString("base64") };
  } catch {
    return null;
  }
}