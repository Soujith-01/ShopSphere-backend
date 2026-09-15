# Product Photo Uploads (Cloudinary)

Sellers add product photos by picking files or using their phone camera. They never
type or paste image URLs, and the Cloudinary API secret never leaves the server.

```
Seller picks a photo (gallery / camera / desktop file picker)
        ↓
Browser downscales it to max 1600px (src/imageResize.js)
        ↓
POST /api/seller/products/upload-image   (multipart/form-data, field "image")
        ↓
Backend validates type + size → streams the buffer to Cloudinary
        ↓
Cloudinary returns secure_url + public_id
        ↓
Backend responds { success: true, data: { url, publicId } }
        ↓
Form keeps { url, publicId } per photo; on save the product is written to MongoDB
        ↓
Product.images = [{ url, publicId, alt, sortOrder }]
        ↓
The existing sheet sync mirrors those URLs into the seller's `imageUrls` column
```

## Storage contract

| Piece | Where it lives |
|---|---|
| Image bytes | Cloudinary only — never MongoDB, never disk (`multer.memoryStorage()`) |
| `images.url` | Cloudinary `secure_url` |
| `images.publicId` | Cloudinary `public_id` (`shopsphere/products/…`) |
| `images.alt` | client value, defaulting to the product name |
| `images.sortOrder` | derived from the array order (index 0 = cover) — never trusted from the client |
| `imageUrls` (sheet) | comma-joined Cloudinary URLs, written by the existing sync |

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/seller/products/upload-image` | One photo, field `image` → `{ success, data: { url, publicId } }` |
| POST | `/api/seller/products/discard-images` | Body `{ publicIds: [] }` → deletes uploaded photos that were never saved |
| POST | `/api/seller/uploads` | Legacy generic upload (single `image` → object, else array) |
| POST | `/api/seller/uploads/multiple` | Legacy batch upload (field `images`) |

All of them sit behind `protect` + `requireSeller`, so only an authenticated, verified
seller can upload. The seller identity comes from the auth middleware — the request
body is never trusted for `sellerId`, and the target spreadsheet is resolved from the
authenticated seller → store → `store.googleSheet.spreadsheetId`.

**Validation:** JPG / JPEG / PNG / WEBP only (`ALLOWED_IMAGE_MIME_TYPES`), max 8 MB per
photo and 10 photos per product. Rejections are friendly, e.g.
`That photo is too large — the limit is 8 MB…` (413) and
`Unsupported image type — please use a JPG, PNG or WEBP photo` (415).

## When Cloudinary assets are deleted

1. **Photo removed or replaced in an edit** → the backend diffs the product's previous
   and new `publicId`s after the update is saved, and deletes the ones that are gone.
   Nothing is deleted before the update validates (`services/cloudinaryService.js`).
2. **Draft product hard-deleted** → its photos are deleted with it. (Soft-deleted
   products keep theirs so a restored listing still shows images.)
3. **Photo URL deleted from the Google Sheet** → the importer notices that the URL is
   gone, saves the shorter list, then deletes the now-unreferenced asset.
4. **Form abandoned after uploading** → the form calls `discard-images` with the
   publicIds uploaded during that session, so orphaned photos don't pile up.

Only public ids under `shopsphere/products/` can ever be destroyed, so a crafted
request cannot delete another project's or another seller's asset.

## Environment variables

```
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

No new dependency is needed — `cloudinary` and `multer` are already in
`Backend/package.json`. If they are ever missing:

```bash
cd Backend && npm install cloudinary multer
```

Without the three variables the upload endpoints answer `503` with a message telling
the seller uploads aren't configured, and everything else keeps working.

## Testing

### Round trip from the command line

```bash
cd Backend && node scripts/test-image-upload.js
```

Builds a valid 4×4 PNG in memory, uploads it through the real service, checks the
delivered URL responds, deletes the asset and confirms through the Cloudinary Admin API
that it is gone (plus a guard check that a public id outside `shopsphere/products/` is
refused). The temporary asset is removed in the same run.

### API level (any photo on disk)

```bash
# 1. log in as a verified seller and copy the access token
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"your-password"}'

# 2. upload a photo
curl -X POST http://localhost:3000/api/seller/products/upload-image \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -F "image=@/path/to/photo.jpg"
# → { "success": true, "data": { "url": "https://res.cloudinary.com/...", "publicId": "shopsphere/products/..." } }

# 3. failure cases
curl -X POST http://localhost:3000/api/seller/products/upload-image -H "Authorization: Bearer <ACCESS_TOKEN>" -F "image=@notes.txt"   # 415 unsupported type
curl ... -F "image=@huge.jpg"                                                                                                        # 413 too large
curl -X POST http://localhost:3000/api/seller/products/upload-image -F "image=@photo.jpg"                                             # 401 no token
```

### Desktop

1. Seller dashboard → Products → **New product** (or edit an existing one).
2. **Product Photos** → *Choose photos (crop / resize)* → pick one or more files.
3. Each photo lands in the gallery: **★** sets the cover, **◀ ▶** reorder, **↻**
   replaces one in place, **✕** removes it.
4. Press *Create product* / *Save changes* → the product appears with its photos, and
   the seller's Google Sheet `imageUrls` column shows the Cloudinary URLs.
5. Re-open the product (edit) → the saved photos are listed in the same order.

### Mobile

1. Open the seller dashboard on the phone browser.
2. **📷 Take photo** opens the camera (`capture="environment"`); **🖼️ Choose photos**
   opens the gallery/file picker; **📁 Add from this device** is the plain multi-select.
3. A full-size camera photo is resized on the device before upload, so uploads stay
   small on mobile data; the buttons show `Uploading 2 of 5…` and disable while working.
4. The Save button is disabled until every photo finishes uploading (no duplicate
   submissions), and errors surface as toasts (`Photo: image is too large…`).
