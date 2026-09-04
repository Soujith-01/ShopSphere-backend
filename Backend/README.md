# Freebuff Backend API

Multi-vendor e-commerce backend — Express 5, MongoDB, Socket.io.

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| **Express 5** | HTTP server & routing |
| **MongoDB / Mongoose 9** | Database & ODM |
| **Socket.io** | Real-time notifications |
| **JWT** | Access + refresh token auth |
| **bcryptjs** | Password hashing |
| **Google OAuth 2.0** | Social login |
| **Cloudinary** | Image uploads |
| **Helmet** | Security headers |
| **express-validator** | Input validation |

---

## Project Structure

```
Backend/
├── server.js              # Entry point, Socket.io, middleware, route mounting
├── middlewares/
│   ├── authMiddleware.js  # JWT protect + role-based authorize()
│   ├── sellerMiddleware.js# requireSeller + checkOwnership()
│   ├── errorMiddleware.js # 404 + global error handler
│   └── validateMiddleware.js
├── models/                # 15 Mongoose models
├── utils/
│   ├── tokenUtils.js      # JWT generation + cookie helpers
│   └── helpers.js         # Slug, order number, discount, pagination
└── APIS/                  # 27 inline route files (handler logic directly in routes)
    ├── auth/auth.js       # 8 endpoints
    ├── customer/          # 10 modules, 43 endpoints
    ├── seller/            # 5 modules, 27 endpoints
    ├── admin/             # 7 modules, 31 endpoints
    ├── delivery/routes.js # 8 endpoints
    └── support/routes.js  # 7 endpoints
```

---

## API Style

Every route is a single `.js` file with handler logic written inline — no separate controller files. Each route has a comment above it explaining what it does. No `try/catch` blocks — Express 5 automatically catches async errors and forwards them to the `errorHandler` middleware.

```js
// List all registered users
router.get('/', async (req, res) => {
  const users = await User.find().select('-password')
  res.json({ users })
  // errors auto-forward to errorHandler middleware
})
```

---

## Routes Overview

### Auth (`/api/auth`) — 8 endpoints
| Comment | Method | Endpoint |
|---------|--------|----------|
| Register a customer or seller account (sellers pass `role: "seller"` + `businessName`, gets a Seller profile) | POST | `/register` |
| Login with email and password | POST | `/login` |
| Logout — clear tokens | POST | `/logout` |
| Refresh access token | POST | `/refresh` |
| Google OAuth login or register | POST | `/google` |
| Forgot password — generates reset token | POST | `/forgot-password` |
| Reset password using token from email | PUT | `/reset-password/:token` |
| Get current user's profile | GET | `/me` |

### Customer (`/api/customer`) — 43 endpoints

**Products (Public)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Get featured products for homepage | GET | `/featured` |
| Get all active products with filters | GET | `/` |
| Get products by category slug | GET | `/category/:categorySlug` |
| Get single product detail by slug | GET | `/:slug` |

**Categories (Public)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Get all top-level categories with nested children | GET | `/` |
| Get category by slug with attribute template | GET | `/:slug` |

**Cart (Protected)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Get user's cart with populated items | GET | `/` |
| Add item to cart (with optional variant) | POST | `/` |
| Update cart item quantity | PUT | `/:itemId` |
| Remove a single item from cart | DELETE | `/:itemId` |
| Clear entire cart | DELETE | `/` |

**Wishlist (Protected)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Get user's wishlist with populated product details | GET | `/` |
| Toggle product in/out of wishlist | POST | `/toggle` |
| Check if a product is in the wishlist | GET | `/check/:productId` |

**Orders (Protected)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Get my parent orders (checkout-level view) | GET | `/parents` |
| Checkout — creates parent order + sub-orders per seller | POST | `/checkout` |
| Get my orders with pagination | GET | `/` |
| Get single order detail | GET | `/:orderId` |
| Cancel order (placed/confirmed only) | PUT | `/:orderId/cancel` |

**Reviews (Protected)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Get reviews for a product | GET | `/product/:productId` |
| Create a review (verified purchase only) | POST | `/` |
| Update own review | PUT | `/:reviewId` |
| Delete own review | DELETE | `/:reviewId` |

**Coupons**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Validate a coupon code and preview discount | POST | `/validate` |
| Apply coupon to user's cart | POST | `/apply` |
| Remove coupon from cart | DELETE | `/remove` |

**Users (Protected)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Get current user's profile | GET | `/me` |
| Update profile (name, phone) | PUT | `/me` |
| Add a new address | POST | `/me/addresses` |
| Update an existing address | PUT | `/me/addresses/:addressId` |
| Delete an address (reassigns default) | DELETE | `/me/addresses/:addressId` |
| Set an address as default | PUT | `/me/addresses/:addressId/default` |

**Notifications (Protected)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Mark all notifications as read | PUT | `/read-all` |
| Get notifications with unread count | GET | `/` |
| Mark a single notification as read | PUT | `/:notificationId/read` |
| Delete a notification | DELETE | `/:notificationId` |

**Support Tickets (Protected)**
| Comment | Method | Endpoint |
|---------|--------|----------|
| Create a support ticket with first message | POST | `/tickets` |
| Get my tickets with pagination | GET | `/tickets` |
| Get ticket detail with threaded messages | GET | `/tickets/:ticketId` |
| Reply to a ticket | POST | `/tickets/:ticketId/messages` |

### Seller (`/api/seller`) — 27 endpoints
All routes require auth + verified seller role.

| Comment | Method | Endpoint |
|---------|--------|----------|
| List all products belonging to this seller | GET | `/products` |
| Create a new product (starts as draft) | POST | `/products` |
| Submit product for admin review | POST | `/products/:id/submit` |
| Get single product detail by ID with variants | GET | `/products/:id` |
| Update a product | PUT | `/products/:id` |
| Delete a product (hard if draft, soft otherwise) | DELETE | `/products/:id` |
| List all variants for a product | GET | `/products/:pid/variants` |
| Create a variant for a product | POST | `/products/:pid/variants` |
| Update a variant | PUT | `/products/:pid/variants/:vid` |
| Delete a variant | DELETE | `/products/:pid/variants/:vid` |
| Update variant stock and threshold | PUT | `/products/:pid/variants/:vid/stock` |
| Get seller's store details | GET | `/store` |
| Create a new store | POST | `/store` |
| Update store details | PUT | `/store` |
| List all orders for this seller | GET | `/orders` |
| Cancel an order | PUT | `/orders/:id/cancel` |
| Get single order detail | GET | `/orders/:id` |
| Update order status (state machine) | PUT | `/orders/:id/status` |
| List all return requests | GET | `/returns` |
| Approve a return request | PUT | `/returns/:id/approve` |
| Reject a return request | PUT | `/returns/:id/reject` |
| Mark return as received and restore stock | PUT | `/returns/:id/receive` |
| Get seller dashboard stats | GET | `/dashboard` |
| Get recent orders for dashboard widget | GET | `/dashboard/recent-orders` |
| Get revenue chart data | GET | `/dashboard/revenue-chart` |

### Admin (`/api/admin`) — 31 endpoints
All routes require auth + admin role.

| Comment | Method | Endpoint |
|---------|--------|----------|
| Get user counts by role | GET | `/users/stats` |
| List all users with filters | GET | `/users` |
| Get single user detail | GET | `/users/:id` |
| Update user role/status | PUT | `/users/:id` |
| Deactivate user account | PUT | `/users/:id/deactivate` |
| List all sellers | GET | `/sellers` |
| Get single seller detail with store | GET | `/sellers/:id` |
| Verify a seller | PUT | `/sellers/:id/verify` |
| Deactivate a seller | PUT | `/sellers/:id/deactivate` |
| Get moderation queue | GET | `/products/moderation` |
| List all products | GET | `/products` |
| Approve a pending product | PUT | `/products/:id/approve` |
| Reject a product with reason | PUT | `/products/:id/reject` |
| Toggle product featured status | PUT | `/products/:id/featured` |
| List all categories | GET | `/categories` |
| Create a category | POST | `/categories` |
| Update a category | PUT | `/categories/:id` |
| Delete a category (blocks if has children) | DELETE | `/categories/:id` |
| List all coupons | GET | `/coupons` |
| Create a new coupon | POST | `/coupons` |
| Update coupon details | PUT | `/coupons/:id` |
| Toggle coupon active/inactive | PUT | `/coupons/:id/toggle` |
| Delete a coupon | DELETE | `/coupons/:id` |
| Get order analytics | GET | `/orders/stats` |
| List all orders | GET | `/orders` |
| Get single order detail | GET | `/orders/:id` |
| Get daily revenue data for charts | GET | `/analytics/revenue` |
| Get top sellers ranked by revenue | GET | `/analytics/top-sellers` |
| Get top products by units sold | GET | `/analytics/top-products` |
| Get platform-wide overview | GET | `/analytics` |

### Delivery (`/api/delivery`) — 8 endpoints
All routes require auth + delivery role.

| Comment | Method | Endpoint |
|---------|--------|----------|
| Update delivery partner profile | PUT | `/profile` |
| Update current GPS location | PUT | `/location` |
| Get delivery stats | GET | `/stats` |
| Browse available orders | GET | `/orders/available` |
| Get my active deliveries | GET | `/orders/active` |
| Get delivery history | GET | `/orders/history` |
| Accept an order | PUT | `/orders/:id/accept` |
| Mark order as delivered | PUT | `/orders/:id/deliver` |

### AI Gemini (`/api/ai`) — 4 endpoints
Gemini-powered product copywriting, semantic search, and behavior recommendations.
See **[`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)** for full setup.

| Comment | Method | Endpoint | Auth |
|---------|--------|----------|------|
| Generate product description + 4-6 selling points (Gemini) | POST | `/product-description` | 🔒 seller |
| Semantic search (vector, falls back to keyword) | GET | `/search?q=...` | public |
| Log user behavior event (VIEW/CLICK/SEARCH/WISHLIST/ADD_TO_CART/PURCHASE) | POST | `/events` | 🔒 any user |
| Behavior-based recommendations (popular fallback) | GET | `/recommendations` | 🔒 any user |

### Support (`/api/support`) — 7 endpoints
All routes require auth + support or admin role.

| Comment | Method | Endpoint |
|---------|--------|----------|
| Get support agent dashboard stats | GET | `/stats` |
| List all tickets with filters | GET | `/tickets` |
| Get ticket detail with messages | GET | `/tickets/:id` |
| Assign ticket to self or another agent | PUT | `/tickets/:id/assign` |
| Reply to a ticket | POST | `/tickets/:id/messages` |
| Update ticket status | PUT | `/tickets/:id/status` |
| Update ticket priority | PUT | `/tickets/:id/priority` |

---

## Key Features

- **Multi-Vendor Order Splitting** — checkout auto-splits into sub-orders per seller
- **Order State Machine** — placed→confirmed→packed→shipped→out_for_delivery→delivered with full audit trail
- **Return/Refund Workflow** — pending→approved→return_shipped→return_received→refunded
- **Product Moderation** — draft→pending→admin approves→active
- **Coupon System** — platform/seller/category/product scoped with usage limits
- **Real-Time Notifications** — Socket.io ready, deep-link targets for frontend routing
- **Audit Logging** — all admin actions tracked with auto-deletion after 90 days
- **Geospatial Support** — 2dsphere indexes for delivery partner & store locations
- **Gemini AI** — AI product descriptions, semantic vector search (Atlas), user-behavior recommendations with weighted events (`services/ai/*`)

---

## Models

| Model | Purpose |
|-------|---------|
| **User** | Multi-role (customer/seller/admin/support/delivery) with addresses & wishlist |
| **Seller** | Business profiles with verification, stats, commission |
| **Store** | Seller storefronts with logo, banner, policies, social links |
| **Category** | Nested hierarchy with attribute templates |
| **Product** | Products with variants, pricing, shipping, stats |
| **Variant** | SKU-level options with stock tracking |
| **Cart** | Per-user carts with coupon support |
| **Order** | Sub-orders per seller with state machine |
| **ParentOrder** | Checkout grouping across sellers |
| **Review** | Verified-purchase reviews with seller response |
| **ReturnRequest** | Return/refund workflow |
| **Coupon** | Multi-scope discount codes |
| **SupportTicket** | Ticketing with threaded messages |
| **Notification** | Typed events with deep links |
| **AuditLog** | Admin action trail (auto-delete 90 days) |
| **UserEvent** | User behavior events (VIEW/CLICK/SEARCH/WISHLIST/ADD_TO_CART/PURCHASE) powering recommendations |

---

## Setup

```bash
npm install
npm run dev    # development (nodemon)
npm start      # production
```

### Environment Variables
```env
PORT=3000
NODE_ENV=development
CLIENT_URL=http://localhost:5173
MONGODB_URI=mongodb://localhost:27017/freebuff
JWT_SECRET=your-secret            # used by default (see below)
JWT_ACCESS_SECRET=your-access-secret   # optional — overrides JWT_SECRET for access tokens
JWT_REFRESH_SECRET=your-refresh-secret # optional — overrides JWT_SECRET for refresh tokens
GOOGLE_CLIENT_ID=your-google-client-id
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
# Gemini AI (optional — search/recommendations degrade gracefully without it)
GEMINI_API_KEY=
GEMINI_TEXT_MODEL=gemini-2.0-flash
GEMINI_EMBEDDING_MODEL=text-embedding-004
GEMINI_EMBEDDING_DIMENSIONS=768   # must equal the Atlas vector index dimension
ATLAS_VECTOR_INDEX_NAME=product_embedding_index
```
> JWT signing/verification falls back to `JWT_SECRET` when the dedicated access/refresh secrets are absent — one variable is enough to run.

---

## Automated API Testing

**`common-req.http`** — hand-test every route from VS Code (REST Client extension).
All role tokens are captured automatically from the named `loginCustomer` / `loginSeller` / … blocks;
run the register request once, then the matching login, and the token flows into every request that needs it.
Customers and **sellers** both register through `POST /api/auth/register` — sellers pass
`role: "seller"` + `businessName`, which creates their Seller profile automatically
(unverified until an admin verifies them). Only staff roles (admin/delivery/support) have no
public registration — seed those in the DB (see the bootstrap inside `test-api.mjs`).

**`test-api.mjs`** — automated end-to-end runner (153 assertions) that boots all five roles,
exercises every module (auth, customers, cart, orders, reviews, coupons, seller store/products/orders/
returns/dashboard, admin users/sellers/products/categories/coupons/orders/analytics, delivery, support),
and reports PASS/FAIL per request. It drops its test database on exit.

```bash
# terminal 1 — server against an isolated test DB
PORT=3001 MONGODB_URI=mongodb://localhost:27017/shopsphere_apitest node server.js

# terminal 2 — run the suite
cd Backend && node test-api.mjs          # add CLEANUP_AT_END=0 to keep the data after the run
```

> Note: checkout intentionally runs **without** MongoDB transactions so it also works on a standalone
> `mongod` (transactions require a replica set). All writes happen after full validation.

**`test/ai.test.mjs`** — unit tests for the AI services with a **mocked Gemini client** (no API key
or network needed): `npm test`. The e2e runner above also verifies AI fallbacks (keyword search,
popular recommendations, seller/503 guards) without a key.
