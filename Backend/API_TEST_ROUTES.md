# 🧪 Freebuff Desktop — API Test Routes

> **Base URL:** `http://localhost:3000`
>
> Copy-paste these into Postman, Thunder Client, or any HTTP client.
> Routes marked 🔒 need a Bearer token in the `Authorization` header.
> Routes marked 👤 need a customer token.
> Routes marked 🏪 need a seller token (via `/api/auth/login` with a seller account).
> Routes marked 🔐 need an admin token.
> Routes marked 🚚 need a delivery partner token.
> Routes marked 🎧 need a support agent token.

---

## 🔑 AUTH — `/api/auth`

### Register (customer)
```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "Test User",
  "email": "test@example.com",
  "password": "password123",
  "role": "customer"
}
```

### Register (seller — creates User + Seller profile automatically)
```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "Store Owner",
  "email": "seller@example.com",
  "password": "password123",
  "role": "seller",
  "businessName": "My Store",
  "businessType": "individual"
}
```
> Seller starts **pending** — an approval request is sent to admins and login is blocked (403)
> until an admin approves via `PUT /api/admin/sellers/:sellerId/verify` or rejects via
> `PUT /api/admin/sellers/:sellerId/reject` (reason required). The register response
> includes `requiresApproval: true` and **no** session/accessToken.
> Only customers and sellers can self-register; admin/delivery/support are staff roles.

### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "test@example.com",
  "password": "password123"
}
```

### Logout 🔒
```http
POST /api/auth/logout
Authorization: Bearer <token>
```

### Refresh Token
```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "<refresh_token>"
}
```

### Google OAuth Login
```http
POST /api/auth/google
Content-Type: application/json

{
  "credential": "<google_id_token>"
}
```

### Forgot Password
```http
POST /api/auth/forgot-password
Content-Type: application/json

{
  "email": "test@example.com"
}
```

### Reset Password
```http
PUT /api/auth/reset-password/<token>
Content-Type: application/json

{
  "password": "newpassword123"
}
```

### Get Me 🔒
```http
GET /api/auth/me
Authorization: Bearer <token>
```

---

## 👤 CUSTOMER — `/api/customer`

### Products

#### Get Featured Products (Homepage)
```http
GET /api/customer/products/featured?limit=12
```

#### Browse All Products (with filters)
```http
GET /api/customer/products?page=1&limit=20&search=phone&category=<categoryId>&minPrice=100&maxPrice=5000&sort=price_asc&rating=4&freeShipping=true
```

#### Get Products by Category Slug
```http
GET /api/customer/products/category/<categorySlug>?page=1&limit=20&sort=popular
```

#### Get Product Detail by Slug
```http
GET /api/customer/products/<productSlug>
```

---

### Categories

#### Get All Top-Level Categories
```http
GET /api/customer/categories
```

#### Get Category by Slug (with children)
```http
GET /api/customer/categories/<categorySlug>
```

---

### Cart 🔒

#### Get My Cart
```http
GET /api/customer/cart
Authorization: Bearer <customer_token>
```

#### Add Item to Cart
```http
POST /api/customer/cart
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "productId": "<productId>",
  "variantId": "<variantId>",   // optional
  "quantity": 1
}
```

#### Update Cart Item Quantity
```http
PUT /api/customer/cart/<itemId>
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "quantity": 3
}
```

#### Remove Item from Cart
```http
DELETE /api/customer/cart/<itemId>
Authorization: Bearer <customer_token>
```

#### Clear Entire Cart
```http
DELETE /api/customer/cart
Authorization: Bearer <customer_token>
```

---

### Wishlist 🔒

#### Get My Wishlist
```http
GET /api/customer/wishlist
Authorization: Bearer <customer_token>
```

#### Toggle Product in Wishlist
```http
POST /api/customer/wishlist/toggle
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "productId": "<productId>"
}
```

#### Check if Product is Wishlisted
```http
GET /api/customer/wishlist/check/<productId>
Authorization: Bearer <customer_token>
```

---

### Orders 🔒

#### Checkout (Place Order)
```http
POST /api/customer/orders/checkout
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "shippingAddressId": "<addressId>",   // OR use inline address below
  "address": {
    "fullName": "Test User",
    "phone": "9876543210",
    "street": "123 Main St",
    "pincode": "110001"
  },
  "paymentMethod": "cod",
  "couponCode": "SAVE10",               // optional
  "customerNote": "Leave at door"       // optional
}
```

#### Get My Orders
```http
GET /api/customer/orders?page=1&limit=20&status=delivered
Authorization: Bearer <customer_token>
```

#### Get My Parent Orders (Grouped by Checkout)
```http
GET /api/customer/orders/parents?page=1&limit=20
Authorization: Bearer <customer_token>
```

#### Get Order Detail
```http
GET /api/customer/orders/<orderId>
Authorization: Bearer <customer_token>
```

#### Cancel Order
```http
PUT /api/customer/orders/<orderId>/cancel
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "reason": "Found a better price elsewhere"
}
```

---

### Reviews 🔒

#### Get Reviews for a Product
```http
GET /api/customer/reviews/product/<productId>?page=1&limit=10&rating=5&sort=newest
Authorization: Bearer <customer_token>
```

#### Create a Review (Verified Purchase Only)
```http
POST /api/customer/reviews
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "productId": "<productId>",
  "orderId": "<orderId>",
  "rating": 5,
  "title": "Great product!",
  "comment": "Really happy with this purchase."
}
```

#### Update My Review
```http
PUT /api/customer/reviews/<reviewId>
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "rating": 4,
  "title": "Updated title",
  "comment": "Updated comment"
}
```

#### Delete My Review
```http
DELETE /api/customer/reviews/<reviewId>
Authorization: Bearer <customer_token>
```

---

### Coupons

#### Validate a Coupon Code 🔒
```http
POST /api/customer/coupons/validate
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "code": "SAVE10",
  "subtotal": 1000
}
```

#### Apply Coupon to Cart 🔒
```http
POST /api/customer/coupons/apply
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "code": "SAVE10"
}
```

#### Remove Coupon from Cart 🔒
```http
DELETE /api/customer/coupons/remove
Authorization: Bearer <customer_token>
```

---

### User Profile 🔒

#### Get My Profile
```http
GET /api/customer/users/me
Authorization: Bearer <customer_token>
```

#### Update My Profile
```http
PUT /api/customer/users/me
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "name": "Updated Name",
  "phone": "9876543210"
}
```

#### Add New Address
```http
POST /api/customer/users/me/addresses
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "label": "Home",
  "fullName": "Test User",
  "phone": "9876543210",
  "street": "123 Main St, Sector 5",
  "pincode": "110001",
  "isDefault": true
}
```

#### Update Address
```http
PUT /api/customer/users/me/addresses/<addressId>
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "street": "456 New Street",
  "pincode": "110002"
}
```

#### Delete Address
```http
DELETE /api/customer/users/me/addresses/<addressId>
Authorization: Bearer <customer_token>
```

#### Set Default Address
```http
PUT /api/customer/users/me/addresses/<addressId>/default
Authorization: Bearer <customer_token>
```

---

### Notifications 🔒

#### Get My Notifications
```http
GET /api/customer/notifications?page=1&limit=20&unreadOnly=true
Authorization: Bearer <customer_token>
```

#### Mark All as Read
```http
PUT /api/customer/notifications/read-all
Authorization: Bearer <customer_token>
```

#### Mark Single Notification as Read
```http
PUT /api/customer/notifications/<notificationId>/read
Authorization: Bearer <customer_token>
```

#### Delete a Notification
```http
DELETE /api/customer/notifications/<notificationId>
Authorization: Bearer <customer_token>
```

---

### Support Tickets 🔒

#### Create Support Ticket
```http
POST /api/customer/support/tickets
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "subject": "Order not received",
  "category": "delivery",
  "priority": "high",
  "orderId": "<orderId>",              // optional
  "productId": "<productId>",          // optional
  "message": "My order was supposed to arrive yesterday but I haven't received it yet."
}
```

#### Get My Tickets
```http
GET /api/customer/support/tickets?page=1&limit=20&status=open
Authorization: Bearer <customer_token>
```

#### Get Ticket Detail (with messages)
```http
GET /api/customer/support/tickets/<ticketId>
Authorization: Bearer <customer_token>
```

#### Reply to a Ticket
```http
POST /api/customer/support/tickets/<ticketId>/messages
Authorization: Bearer <customer_token>
Content-Type: application/json

{
  "message": "Still waiting for a response on this."
}
```

---

## 🏪 SELLER — `/api/seller`
> All seller routes require `protect` + `requireSeller` middleware.
> Sellers register publicly via `/api/auth/register` with `role: "seller"` + `businessName`,
> then must be approved by an admin (`PUT /api/admin/sellers/:sellerId/verify`) before they
> can log in or call any seller route. Rejected applications (`.../reject`) stay locked out
> until approved.

### Products

#### List My Products
```http
GET /api/seller/products?page=1&limit=20&status=active&search=phone
Authorization: Bearer <seller_token>
```

#### Create a Product (Auto-Published — Live for Customers Immediately)
```http
POST /api/seller/products
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "name": "Wireless Mouse",
  "description": "Ergonomic wireless mouse with USB receiver",
  "price": 799,
  "category": "<categoryId>",
  "tags": ["electronics", "mouse"],
  "images": [{"url": "https://example.com/img.jpg", "publicId": ""}],
  "hasVariants": false,
  "store": "<storeId>"
}
```

#### Get Product Detail
```http
GET /api/seller/products/<productId>
Authorization: Bearer <seller_token>
```

#### Update a Product
```http
PUT /api/seller/products/<productId>
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "price": 699,
  "description": "Updated description"
}
```

#### Publish a Draft / Republish a Rejected Product
Products are auto-published on create, so this endpoint is only needed to
republish a product that an admin rejected (or to publish legacy drafts).
```http
POST /api/seller/products/<productId>/submit
Authorization: Bearer <seller_token>
```

#### Delete a Product
```http
DELETE /api/seller/products/<productId>
Authorization: Bearer <seller_token>
```

#### List Variants for a Product
```http
GET /api/seller/products/<productId>/variants
Authorization: Bearer <seller_token>
```

#### Create a Variant
```http
POST /api/seller/products/<productId>/variants
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "options": {"color": "Red", "size": "M"},
  "label": "Red - M",
  "sku": "WM-RED-M",
  "price": 849,
  "stock": 50,
  "lowStockThreshold": 5,
  "weight": 200
}
```

#### Update a Variant
```http
PUT /api/seller/products/<productId>/variants/<variantId>
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "price": 799,
  "stock": 100
}
```

#### Delete a Variant
```http
DELETE /api/seller/products/<productId>/variants/<variantId>
Authorization: Bearer <seller_token>
```

#### Update Variant Stock
```http
PUT /api/seller/products/<productId>/variants/<variantId>/stock
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "stock": 75,
  "lowStockThreshold": 10
}
```

---

### Store

#### Get My Store
```http
GET /api/seller/store
Authorization: Bearer <seller_token>
```

#### Create My Store
```http
POST /api/seller/store
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "name": "My Awesome Store",
  "description": "Best electronics store online",
  "tagline": "Quality you can trust",
  "logo": {"url": "https://example.com/logo.png", "publicId": ""},
  "banner": {"url": "https://example.com/banner.jpg", "publicId": ""},
  "address": {"street": "123 Market Road", "city": "Delhi", "state": "DL", "pincode": "110001"},
  "policies": {"returnPolicy": "7-day return", "shippingPolicy": "Free above ₹500"},
  "socialLinks": {"website": "https://mystore.com", "instagram": "@mystore"}
}
```

#### Update My Store
```http
PUT /api/seller/store
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "description": "Updated store description",
  "tagline": "New tagline"
}
```

---

### Orders

#### List My Orders
```http
GET /api/seller/orders?page=1&limit=20&status=placed&search=ORD
Authorization: Bearer <seller_token>
```

#### Get Order Detail
```http
GET /api/seller/orders/<orderId>
Authorization: Bearer <seller_token>
```

#### Update Order Status (State Machine)
```http
PUT /api/seller/orders/<orderId>/status
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "status": "confirmed",
  "note": "Order confirmed, will ship tomorrow",
  "trackingNumber": "TRK123456",           // optional, for shipped status
  "estimatedDelivery": "2026-09-10"         // optional, ISO date string
}
```
> **Status flow:** placed → confirmed → packed → shipped → out_for_delivery → delivered

#### Cancel Order
```http
PUT /api/seller/orders/<orderId>/cancel
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "reason": "Out of stock"
}
```

---

### Returns

#### List Return Requests
```http
GET /api/seller/returns?page=1&limit=20&status=pending
Authorization: Bearer <seller_token>
```

#### Approve a Return
```http
PUT /api/seller/returns/<returnId>/approve
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "note": "Return approved, please ship back within 7 days"
}
```

#### Reject a Return
```http
PUT /api/seller/returns/<returnId>/reject
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "note": "Return window has expired"
}
```

#### Mark Return as Received (Restores Stock)
```http
PUT /api/seller/returns/<returnId>/receive
Authorization: Bearer <seller_token>
```

---

### Dashboard

#### Get Dashboard Stats
```http
GET /api/seller/dashboard
Authorization: Bearer <seller_token>
```

#### Get Recent Orders
```http
GET /api/seller/dashboard/recent-orders?limit=10
Authorization: Bearer <seller_token>
```

#### Get Revenue Chart Data
```http
GET /api/seller/dashboard/revenue-chart?days=30
Authorization: Bearer <seller_token>
```

---

## 🔐 ADMIN — `/api/admin`
> All admin routes require `protect` + `authorize("admin")` middleware.

### Users

#### Get User Stats (by role, active/inactive)
```http
GET /api/admin/users/stats
Authorization: Bearer <admin_token>
```

#### List All Users
```http
GET /api/admin/users?page=1&limit=20&role=customer&isActive=true&search=john
Authorization: Bearer <admin_token>
```

#### Get User Detail
```http
GET /api/admin/users/<userId>
Authorization: Bearer <admin_token>
```

#### Update User (role, status, name, phone)
```http
PUT /api/admin/users/<userId>
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "role": "seller",
  "isActive": true,
  "name": "Updated Name"
}
```

#### Deactivate User
```http
PUT /api/admin/users/<userId>/deactivate
Authorization: Bearer <admin_token>
```

---

### Sellers

#### List All Sellers
```http
GET /api/admin/sellers?page=1&limit=20&isVerified=true&search=store
Authorization: Bearer <admin_token>
```

#### Get Seller Detail (with store)
```http
GET /api/admin/sellers/<sellerId>
Authorization: Bearer <admin_token>
```

#### Verify (Approve) a Seller
```http
PUT /api/admin/sellers/<sellerId>/verify
Authorization: Bearer <admin_token>
```
> Sets `status: "approved"`, clears any rejection, notifies the seller, and unlocks login.

#### Reject a Seller Application
```http
PUT /api/admin/sellers/<sellerId>/reject
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "reason": "Incomplete business documents"
}
```
> `reason` is required (max 500 chars). Sets `status: "rejected"`, stores the reason, notifies
> the seller, and keeps login blocked. A rejected seller can be approved later via `/verify`.

#### Admin Notifications (Seller Approval Requests)
```http
GET /api/admin/notifications?unreadOnly=true&page=1&limit=20
Authorization: Bearer <admin_token>
```

#### Mark All Admin Notifications Read
```http
PUT /api/admin/notifications/read-all
Authorization: Bearer <admin_token>
```

#### Mark One Admin Notification Read
```http
PUT /api/admin/notifications/<notificationId>/read
Authorization: Bearer <admin_token>
```

#### Delete an Admin Notification
```http
DELETE /api/admin/notifications/<notificationId>
Authorization: Bearer <admin_token>
```

#### Deactivate a Seller
```http
PUT /api/admin/sellers/<sellerId>/deactivate
Authorization: Bearer <admin_token>
```

---

### Products

#### Get Moderation Queue (Pending Products)
```http
GET /api/admin/products/moderation?page=1&limit=20&status=pending
Authorization: Bearer <admin_token>
```

#### List All Products (Any Status)
```http
GET /api/admin/products?page=1&limit=20&status=active&search=phone
Authorization: Bearer <admin_token>
```

#### Approve a Product
```http
PUT /api/admin/products/<productId>/approve
Authorization: Bearer <admin_token>
```

#### Reject a Product
```http
PUT /api/admin/products/<productId>/reject
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "reason": "Product description is misleading"
}
```

#### Toggle Featured
```http
PUT /api/admin/products/<productId>/featured
Authorization: Bearer <admin_token>
```

---

### Categories

#### List All Categories
```http
GET /api/admin/categories?level=0&includeInactive=true
Authorization: Bearer <admin_token>
```

#### Create Category
```http
POST /api/admin/categories
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "name": "Electronics",
  "description": "All electronic gadgets",
  "parentCategory": null,
  "image": {"url": "https://example.com/cat.jpg", "publicId": ""},
  "attributes": [
    {"name": "Brand", "type": "text", "required": true},
    {"name": "Warranty", "type": "select", "options": ["1 Year", "2 Years"], "required": false}
  ],
  "sortOrder": 1,
  "isFeatured": true
}
```

#### Update Category
```http
PUT /api/admin/categories/<categoryId>
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "name": "Electronics & Gadgets",
  "sortOrder": 2
}
```

#### Delete Category (Fails if has children)
```http
DELETE /api/admin/categories/<categoryId>
Authorization: Bearer <admin_token>
```

---

### Coupons

#### List All Coupons
```http
GET /api/admin/coupons?page=1&limit=20&isActive=true&scope=platform
Authorization: Bearer <admin_token>
```

#### Create Coupon
```http
POST /api/admin/coupons
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "code": "SAVE10",
  "description": "10% off on orders above ₹500",
  "discountType": "percentage",
  "discountValue": 10,
  "maxDiscountAmount": 200,
  "minOrderAmount": 500,
  "maxUsageTotal": 100,
  "maxUsagePerUser": 2,
  "validFrom": "2026-09-01",
  "validTo": "2026-12-31",
  "scope": "platform"
}
```

#### Update Coupon
```http
PUT /api/admin/coupons/<couponId>
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "description": "Updated coupon description",
  "maxUsageTotal": 200
}
```

#### Toggle Coupon Active/Inactive
```http
PUT /api/admin/coupons/<couponId>/toggle
Authorization: Bearer <admin_token>
```

#### Delete Coupon
```http
DELETE /api/admin/coupons/<couponId>
Authorization: Bearer <admin_token>
```

---

### Orders

#### Get Order Stats
```http
GET /api/admin/orders/stats
Authorization: Bearer <admin_token>
```

#### List All Orders
```http
GET /api/admin/orders?page=1&limit=20&status=delivered&search=ORD&sellerId=<sellerId>
Authorization: Bearer <admin_token>
```

#### Get Order Detail
```http
GET /api/admin/orders/<orderId>
Authorization: Bearer <admin_token>
```

---

### Analytics

#### Get Platform Overview
```http
GET /api/admin/analytics
Authorization: Bearer <admin_token>
```

#### Get Revenue Chart Data
```http
GET /api/admin/analytics/revenue?days=30
Authorization: Bearer <admin_token>
```

#### Get Top Sellers
```http
GET /api/admin/analytics/top-sellers?limit=10
Authorization: Bearer <admin_token>
```

#### Get Top Products
```http
GET /api/admin/analytics/top-products?limit=10
Authorization: Bearer <admin_token>
```

---

## 🚚 DELIVERY — `/api/delivery`
> All delivery routes require `protect` + `authorize("delivery")` middleware.

### Profile

#### Update Delivery Profile
```http
PUT /api/delivery/profile
Authorization: Bearer <delivery_token>
Content-Type: application/json

{
  "isAvailable": true,
  "vehicleType": "bike",
  "coordinates": [77.1025, 28.7041]
}
```

#### Update GPS Location
```http
PUT /api/delivery/location
Authorization: Bearer <delivery_token>
Content-Type: application/json

{
  "coordinates": [77.1025, 28.7041]
}
```

### Stats

#### Get Delivery Stats
```http
GET /api/delivery/stats
Authorization: Bearer <delivery_token>
```

### Orders

#### Browse Available Orders (Shipped, No Partner Assigned)
```http
GET /api/delivery/orders/available?page=1&limit=20
Authorization: Bearer <delivery_token>
```

#### Get My Active Deliveries
```http
GET /api/delivery/orders/active
Authorization: Bearer <delivery_token>
```

#### Get Delivery History
```http
GET /api/delivery/orders/history?page=1&limit=20
Authorization: Bearer <delivery_token>
```

#### Accept an Order
```http
PUT /api/delivery/orders/<orderId>/accept
Authorization: Bearer <delivery_token>
```

#### Mark Order as Delivered
```http
PUT /api/delivery/orders/<orderId>/deliver
Authorization: Bearer <delivery_token>
Content-Type: application/json

{
  "note": "Left at reception desk"
}
```

---

## 🎧 SUPPORT — `/api/support`
> All support routes require `protect` + `authorize("support", "admin")` middleware.

### Stats

#### Get Support Dashboard Stats
```http
GET /api/support/stats
Authorization: Bearer <support_token>
```

### Tickets

#### List All Tickets (with filters)
```http
GET /api/support/tickets?page=1&limit=20&status=open&priority=high&category=delivery&assignedTo=<agentId>
Authorization: Bearer <support_token>
```

#### Get Ticket Detail (with threaded messages)
```http
GET /api/support/tickets/<ticketId>
Authorization: Bearer <support_token>
```

#### Assign Ticket (to self or another agent)
```http
PUT /api/support/tickets/<ticketId>/assign
Authorization: Bearer <support_token>
Content-Type: application/json

{
  "agentId": "<agentId>"   // optional — omit to assign to self
}
```

#### Reply to Ticket (Agent)
```http
POST /api/support/tickets/<ticketId>/messages
Authorization: Bearer <support_token>
Content-Type: application/json

{
  "message": "We've escalated this to the logistics team. Expected resolution in 24 hours.",
  "attachments": []   // optional: [{"url": "...", "publicId": "..."}]
}
```

#### Update Ticket Status
```http
PUT /api/support/tickets/<ticketId>/status
Authorization: Bearer <support_token>
Content-Type: application/json

{
  "status": "resolved",
  "note": "Issue resolved — refund processed",
  "resolution": "Full refund issued to customer"
}
```
> **Status flow:** open → in_progress → waiting_customer → resolved → closed

#### Update Ticket Priority
```http
PUT /api/support/tickets/<ticketId>/priority
Authorization: Bearer <support_token>
Content-Type: application/json

{
  "priority": "urgent"
}
```

---

## 📋 Quick Test Flow (End-to-End)

```
1. Register customer     → POST /api/auth/register
2. Login as customer     → POST /api/auth/login         → save customer_token
3. Add address           → POST /api/customer/users/me/addresses
4. Browse products       → GET /api/customer/products
5. Add to cart           → POST /api/customer/cart
6. Apply coupon          → POST /api/customer/coupons/apply
7. Checkout              → POST /api/customer/orders/checkout
8. Create support ticket → POST /api/customer/support/tickets

--- Seller Flow ---
9.  Register seller      → POST /api/auth/register (role: seller + businessName)
10. Create store         → POST /api/seller/store
11. Create product       → POST /api/seller/products (goes live immediately — no approval needed)
12. Check dashboard      → GET /api/seller/dashboard
13. (Optional) Admin tools → PUT /api/admin/products/<id>/reject to unpublish, seller resubmits to republish

--- Delivery Flow ---
16. Login as delivery    → POST /api/auth/login (delivery account)
17. Browse available     → GET /api/delivery/orders/available
18. Accept order         → PUT /api/delivery/orders/<id>/accept
19. Mark delivered       → PUT /api/delivery/orders/<id>/deliver

--- Support Flow ---
20. Login as support     → POST /api/auth/login (support account)
21. View tickets         → GET /api/support/tickets
22. Assign to self       → PUT /api/support/tickets/<id>/assign
23. Reply                → POST /api/support/tickets/<id>/messages
24. Resolve              → PUT /api/support/tickets/<id>/status
```

---

## 📊 Route Summary

| Module | Base Path | Total Routes |
|--------|-----------|:------------:|
| Auth | `/api/auth` | 8 |
| Customer Products | `/api/customer/products` | 4 |
| Customer Categories | `/api/customer/categories` | 2 |
| Customer Cart | `/api/customer/cart` | 5 |
| Customer Wishlist | `/api/customer/wishlist` | 3 |
| Customer Orders | `/api/customer/orders` | 5 |
| Customer Reviews | `/api/customer/reviews` | 4 |
| Customer Coupons | `/api/customer/coupons` | 3 |
| Customer Users | `/api/customer/users` | 6 |
| Customer Notifications | `/api/customer/notifications` | 4 |
| Customer Support | `/api/customer/support` | 4 |
| Seller Products | `/api/seller/products` | 10 |
| Seller Store | `/api/seller/store` | 3 |
| Seller Orders | `/api/seller/orders` | 4 |
| Seller Returns | `/api/seller/returns` | 4 |
| Seller Dashboard | `/api/seller/dashboard` | 3 |
| Admin Users | `/api/admin/users` | 5 |
| Admin Sellers | `/api/admin/sellers` | 4 |
| Admin Products | `/api/admin/products` | 5 |
| Admin Categories | `/api/admin/categories` | 4 |
| Admin Coupons | `/api/admin/coupons` | 5 |
| Admin Orders | `/api/admin/orders` | 3 |
| Admin Analytics | `/api/admin/analytics` | 4 |
| Delivery | `/api/delivery` | 7 |
| Support | `/api/support` | 7 |
| **Total** | | **109** |
