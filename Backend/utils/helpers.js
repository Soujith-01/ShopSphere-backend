import crypto from "crypto";

// Generate URL-safe slug from text
export const generateSlug = (text) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
};

// Generate unique order number: ORD-YYYY-XXXXX
export const generateOrderNumber = () => {
  const year = new Date().getFullYear();
  const random = crypto.randomInt(10000, 99999);
  return `ORD-${year}-${random}`;
};

// Generate ticket number: TKT-YYYY-XXXXX
export const generateTicketNumber = () => {
  const year = new Date().getFullYear();
  const random = crypto.randomInt(10000, 99999);
  return `TKT-${year}-${random}`;
};

// Calculate discount
export const calculateDiscount = (price, discount) => {
  if (!discount || !discount.type) return 0;
  if (discount.type === "percentage") {
    const amount = (price * discount.value) / 100;
    return discount.maxAmount ? Math.min(amount, discount.maxAmount) : amount;
  }
  return Math.min(discount.value, price);
};

// Paginate helper
export const paginate = (query, page = 1, limit = 20) => {
  const skip = (page - 1) * limit;
  return query.skip(skip).limit(limit);
};
