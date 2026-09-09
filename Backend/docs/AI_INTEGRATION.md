# ShopSphere — Gemini AI Integration

Backend AI features powered by the official **Google GenAI SDK** (`@google/genai`).

Two features:

1. **AI Product Description + Selling Points** (seller tool)
2. **Semantic Search + User-Behavior Recommendations** (storefront)

All AI code lives under `config/gemini.js` (client) and `services/ai/*` (logic).
No AI code exists on the frontend, and the API key never leaves the server.

---

## 1. Gemini setup

1. Get an API key: <https://aistudio.google.com/apikey>
2. Add it to `Backend/.env`:

```env
GEMINI_API_KEY=your_key_here
GEMINI_TEXT_MODEL=gemini-3.5-flash
GEMINI_FALLBACK_MODELS=gemini-3.6-flash,gemini-3.7-flash
GEMINI_EMBEDDING_MODEL=text-embedding-004
GEMINI_EMBEDDING_DIMENSIONS=768
GEMINI_TEXT_TIMEOUT_MS=20000
GEMINI_EMBEDDING_TIMEOUT_MS=15000
ATLAS_VECTOR_INDEX_NAME=product_embedding_index
```

| Variable | Purpose | Default |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key (never exposed to clients) | — (empty = AI disabled) |
| `GEMINI_TEXT_MODEL` | Primary model for description generation | `gemini-3.5-flash` |
| `GEMINI_FALLBACK_MODELS` | Comma-separated extra models to try when the primary is overloaded/unavailable | `gemini-3.6-flash,gemini-3.7-flash` |
| `GEMINI_EMBEDDING_MODEL` | Model for embeddings | `text-embedding-004` |
| `GEMINI_EMBEDDING_DIMENSIONS` | **Pinned** output dimension — must equal the Atlas vector index dimension | 768 for `text-embedding-004` |
| `GEMINI_TEXT_TIMEOUT_MS` | Max time for a single text call | 20000 |
| `GEMINI_EMBEDDING_TIMEOUT_MS` | Max time for an embedding call | 15000 |
| `ATLAS_VECTOR_INDEX_NAME` | Name of the Atlas vector search index | `product_embedding_index` |

**Resilience (description + chat endpoints):** Gemini text calls retry transient failures
(429/500/503 "high demand", timeouts) and fall through a model chain — primary first,
then known-good defaults (`gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.7-flash`,
`gemini-flash-lite-latest`), then `GEMINI_FALLBACK_MODELS` — bounded to 5 total calls.
Responses are parsed tolerantly (markdown code fences, prose around the JSON, and raw
newlines inside string values are all handled). If every model is overloaded you get a
clean 502 with a friendly "AI service is busy" message; if the account quota is exhausted
the message says so explicitly (`AI_QUOTA`).

> **Dimension warning:** `text-embedding-004` outputs **768** dims, `gemini-embedding-001`
> outputs **3072**. The `GEMINI_EMBEDDING_DIMENSIONS` value **must match** the
> `numDimensions` you configure on the Atlas index, or `$vectorSearch` will fail.
> Pin it explicitly so it can never drift.

If `GEMINI_API_KEY` is empty:

- `POST /api/ai/product-description` → **503** "AI service is not configured"
- `GET /api/ai/search` → silently falls back to keyword search (`searchMode: "keyword"`)
- `GET /api/ai/recommendations` → falls back to popular products (`source: "popular"`)

The marketplace never crashes because of AI — every Gemini call has a timeout and every
failure is caught and degraded.

---

## 2. AI client (`config/gemini.js`)

- Lazy singleton `GoogleGenAI` client, secrets read from env only.
- `generateStructuredJSON({ prompt, schema })` — enforces `responseMimeType: "application/json"` +
  a JSON schema, parses + validates the result, 20s timeout.
- `generateEmbedding({ text })` — returns `number[]`, 15s timeout, pinned
  `outputDimensionality`.
- Errors are normalized to `AIError` with codes:
  `AI_NOT_CONFIGURED`, `AI_TIMEOUT`, `AI_API_ERROR`, `AI_INVALID_RESPONSE`.
  The global error handler returns **502** for these.
- Both accept `deps.client` so unit tests can inject a **mocked** Gemini client
  (see `test/ai.test.mjs` — no real API calls in tests).

---

## 3. Feature 1 — Product description API

```
POST /api/ai/product-description
Authorization: Bearer <seller JWT>
Content-Type: application/json
```

Auth: **seller only** (`protect` + `requireSeller`). Rate limit: **10 requests / 15 min / IP**.

Request:

```json
{
  "name": "Running Shoes",
  "brand": "Nike",
  "category": "Sports",
  "attributes": { "color": "Black", "material": "Mesh" },
  "features": ["Lightweight", "Breathable", "Cushioned sole"],
  "tags": ["running", "sneakers"],
  "imageUrl": "https://res.cloudinary.com/.../product.jpg"
}
```

`attributes` also accepts `[{ "name": "color", "value": "Black" }]`. `brand`, `category`,
`attributes`, `features`, `tags`, and `imageUrl` are optional; `name` is required.

`imageUrl` (a Cloudinary URL from the seller product form) is fetched server-side by
`services/ai/image.js` and sent to Gemini as an image part so the model can also read
visible product details. If the image can't be fetched (bad URL, timeout, non-image,
>10 MB), the request **degrades gracefully to text-only** — it never fails because of
the image.

Response:

```json
{
  "success": true,
  "data": {
    "description": "Lightweight, breathable running shoes with a cushioned sole...",
    "sellingPoints": ["...", "...", "...", "..."]
  }
}
```

Prompt rules (enforced in `services/ai/description.js`):
- Use **ONLY** the supplied product information
- Never invent specifications, certifications, warranty, price, statistics, features, or medical claims
- One professional, concise description (2–4 sentences)
- Exactly **4–6** selling points (deduped + capped at 6)

Both the request and the Gemini response are validated; malformed output → 502.

### Feature 1b — Ask-AI description assistant

```
POST /api/ai/product-description/chat
Authorization: Bearer <seller JWT>
Content-Type: application/json
```

Auth: **seller only** (`protect` + `requireSeller`). Rate limit: **30 requests / 15 min / IP**.

The small chatbot beside the description field on the seller product form. Every request
carries the **current product context + optional image** plus the recent conversation
history, so answers stay grounded in the actual product.

Request:

```json
{
  "message": "Make it more professional",
  "product": {
    "name": "Running Shoes",
    "category": "Sports",
    "description": "Comfortable running shoes.",
    "brand": "Nike",
    "attributes": [{ "name": "color", "value": "Black" }],
    "features": ["Lightweight"],
    "tags": ["running"]
  },
  "history": [
    { "role": "user", "content": "Write a description" },
    { "role": "assistant", "content": "Lightweight shoes..." }
  ],
  "imageUrl": "https://res.cloudinary.com/.../product.jpg"
}
```

Response:

```json
{
  "success": true,
  "data": { "reply": "Engineered for comfort, these running shoes..." }
}
```

- `message` is required (max 1000 chars); `product`, `history` (max 20 turns,
  roles `user`/`assistant`), and `imageUrl` are optional.
- The system prompt (`services/ai/chat.js`) tells Gemini to use **only** the supplied
  product info + image and never invent facts.
- `history` is capped at the last 10 turns server-side.

---

## 4. Embeddings

### Where they are stored

`Product.aiEmbedding: [Number]` — already part of the `Product` schema
(`aiDescription`, `aiSellingPoints` are also available for AI-generated content).

### Embedding text

`services/ai/productText.js` builds a single text blob per product:

```
Product: <name>
Brand: <brand>
Category: <category>
Description: <description>
Selling points: <...>
Attributes: <name: value, ...>
Features: <...>
Tags: <...>
Variants: <label (SKU), ...>
```

`normalizeAIProductFields()` accepts either the description-API request body or a Product
doc (including populated `category` and variants), so prompts and embeddings share one code path.

### When embeddings are generated/updated

`refreshProductEmbedding(productId)` runs **fire-and-forget** (never blocks or fails the
request) after:

| Hook | File |
|---|---|
| Product created | `APIS/seller/products.js` |
| Product updated **only if searchable fields changed** (`name`, `description`, `tags`, `attributes`, `variantOptions`, `category`, `subCategory`, `price`, `discount`, `status`) | `APIS/seller/products.js` |
| Variant created / updated / deleted (variant info is part of the text) | `APIS/seller/products.js` |
| Admin approves a product (becomes searchable) | `APIS/admin/products.js` |

`shouldRefreshEmbedding(modifiedPaths)` makes sure unrelated updates (images, shipping
weight, stats…) do **not** regenerate embeddings.

---

## 5. MongoDB Atlas Vector Search index

Create the index **manually** in Atlas (Deployment → Database → your cluster →
*Atlas Search* → *Create Search Index* → JSON editor):

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "aiEmbedding": {
        "type": "knnVector",
        "dimensions": 768,
        "similarity": "cosine"
      }
    }
  }
}
```

Name it **`product_embedding_index`** (or set `ATLAS_VECTOR_INDEX_NAME`).

- `dimensions` **must equal** `GEMINI_EMBEDDING_DIMENSIONS` (768 for `text-embedding-004`).
- Cosine similarity matches how Gemini embeddings are compared.
- A helper script prints this definition: `node scripts/vector-index.js`.
- Atlas **Vector Search requires an M10+ Atlas cluster** — it does not run on a local
  standalone `mongod` (MongoDB Compass can still browse the Atlas database; the connection
  string is just your Atlas URI).

---

## 6. Feature 2 — Semantic search API

```
GET /api/ai/search?q=comfortable+shoes+for+long+distance+running
```

Public endpoint (rate limit: 60/min/IP).

Flow:

```
user query → Gemini embedding → $vectorSearch on aiEmbedding
  → $match filters → $skip/$limit pagination → populated results
```

Supported filters (same semantics as `/api/customer/products`):

| Param | Meaning |
|---|---|
| `q` | Free-text query (**required**) |
| `category` / `subCategory` | Category ObjectId |
| `seller` / `store` | Seller / store ObjectId |
| `brand` | Matches a `brand` attribute (case-insensitive) |
| `minPrice` / `maxPrice` | Price range |
| `rating` | Minimum `stats.avgRating` |
| `availability` | `in_stock` (non-variant products + variants with stock > 0) or `any` |
| `mode` | `auto` (default), `vector`, `keyword` |
| `page` / `limit` | Pagination (limit ≤ 100) |

Response:

```json
{
  "success": true,
  "data": [ { "name": "...", "slug": "...", "price": 2499, "category": {...}, "store": {...} } ],
  "pagination": { "page": 1, "limit": 20, "total": 42, "pages": 3 },
  "searchMode": "vector"
}
```

- `searchMode` tells the client which engine answered: `vector` or `keyword`.
- **Graceful fallback:** if Gemini is unconfigured, times out, errors, or the vector index
  is missing, the API silently degrades to the existing keyword search
  (`searchMode: "keyword"`) with the **same filters and pagination** — no 500s.

---

## 7. User behavior events

### Model — `models/UserEvent.js`

```js
{
  userId,      // ObjectId → User (from JWT, never from the client!)
  productId,   // ObjectId → Product
  eventType,   // VIEW | CLICK | SEARCH | WISHLIST | ADD_TO_CART | PURCHASE
  metadata,    // mixed, e.g. { query, quantity, source }
  createdAt
}
```

### API

```
POST /api/ai/events
Authorization: Bearer <customer JWT>
Content-Type: application/json

{ "productId": "65f...", "eventType": "VIEW", "metadata": { "source": "search" } }
```

- Requires authentication; `userId` is **always taken from the JWT** — a client-supplied
  `userId` is ignored (security requirement).
- The product must exist (404 otherwise).
- **PURCHASE events are logged automatically at checkout** (`APIS/customer/orders.js`,
  fire-and-forget), so purchase history is captured even if the frontend forgets.
- Rate limit: 120/min/IP.

---

## 8. Recommendations

```
GET /api/ai/recommendations
Authorization: Bearer <customer JWT>
```

Optional filters: `category`, `subCategory`, `seller`, `minPrice`, `maxPrice` (+ `page`/`limit`).
Rate limit: 30/min/IP.

### Logic (`services/ai/recommendations.js`)

1. Collect the user's events from the last **90 days** (plus current `wishlist` and cart items
   as extra signals).
2. Score each interacted product with **configurable event weights**:

   | Event | Weight |
   |---|---|
   | VIEW | 1 |
   | CLICK | 2 |
   | WISHLIST | 4 |
   | ADD_TO_CART | 5 |
   | PURCHASE | 6 |

3. Take the top 25 products, average their embeddings **weighted by score** → user interest vector.
4. `$vectorSearch` with the interest vector → rank by similarity.
5. Filter: `status: active`, has embedding, **exclude already-purchased products**, plus the
   requested filters.
6. **Fallback for new users / insufficient history:** real popular/trending/high-rated
   products (`source: "popular"`) — sorted by `stats.totalSold`, `stats.avgRating`.
   Also the fallback if vector search is unavailable. Nothing is hard-coded — it's always
   computed from live catalog data.

Response includes `source: "behavior" | "popular"` so the client knows which engine answered.

---

## 9. Files created / modified

**New**
- `config/gemini.js` — Gemini client + `generateStructuredJSON` / `generateEmbedding` + `AIError`
- `services/ai/productText.js` — field normalization + embedding text builder
- `services/ai/description.js` — description/selling-points generation
- `services/ai/embedding.js` — query/product embeddings + refresh hook
- `services/ai/search.js` — vector search + filters + keyword fallback
- `services/ai/recommendations.js` — behavior scoring + interest vector + fallbacks
- `models/UserEvent.js` — behavior event model
- `APIS/ai/index.js` — `/api/ai/*` routes (rate-limited, validated)
- `test/ai.test.mjs` — 17 unit tests with mocked Gemini
- `http/ai.http` — ready-to-send request examples
- `docs/AI_INTEGRATION.md` — this document
- `scripts/vector-index.js` — prints the Atlas vector index definition

**Modified**
- `server.js` — mounts `/api/ai`
- `middlewares/errorMiddleware.js` — `AIError` → 502
- `APIS/seller/products.js` — embedding refresh on create / searchable update / variant changes
- `APIS/admin/products.js` — embedding refresh on approve
- `APIS/customer/orders.js` — auto-logs PURCHASE events at checkout
- `models/index.js` — exports `UserEvent`
- `package.json` — added `@google/genai`, `express-rate-limit`; `npm test` runs the AI unit tests
- `.env` — added `GEMINI_*` and `ATLAS_VECTOR_INDEX_NAME`
- `README.md` — AI section
- `common-req.http` — AI request examples

---

## 10. Setup / testing

```bash
cd Backend
npm install            # installs @google/genai + express-rate-limit
# add GEMINI_API_KEY to .env (see section 1)
npm run dev            # start the backend
```

Unit tests (mocked Gemini — no API key, no network):

```bash
npm test               # node --test test/ai.test.mjs  → 17 tests
```

End-to-end suite (no Gemini key needed — verifies fallbacks):

```bash
# terminal 1
PORT=3001 MONGODB_URI=mongodb://localhost:27017/shopsphere_apitest node server.js
# terminal 2
node test-api.mjs      # 166 assertions, includes /api/ai/* fallback + guard checks
```

Live testing with a real key: open `http/ai.http` in VS Code (REST Client) and
`http://localhost:3000` requests — the file documents the full request/response shapes.

## 11. Security & quality checklist

- ✅ JWT auth (`protect`) + seller-only authorization (`requireSeller`)
- ✅ `userId` for events always from JWT
- ✅ Backend validation (express-validator) on every AI endpoint
- ✅ Rate limiting per endpoint (10–120 req/min)
- ✅ Input size limits (name ≤ 200, features ≤ 20 × 200 chars, query ≤ 200, …)
- ✅ Gemini timeouts (text 20s, embedding 15s) — AI can never hang a request
- ✅ Graceful degradation: search → keyword, recommendations → popular, description → 503
- ✅ API key never sent to the client, logged, or committed (`.env` only)
- ✅ Unit tests mock Gemini; no real API calls in CI