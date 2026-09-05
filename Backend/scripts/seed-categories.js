// Seeds a starter category tree (top-level + sub-categories) so sellers have
// categories to assign products to. Safe to re-run: existing categories are
// matched by slug and left untouched.
//
// Usage (from Backend/):  node scripts/seed-categories.js
import mongoose from "mongoose";
import { config } from "dotenv";
import Category from "../models/Category.js";

config();

const CATEGORIES = [
  {
    name: "Electronics",
    slug: "electronics",
    description: "Mobiles, laptops, TVs, audio and gadgets",
    attributes: [
      { name: "Brand", type: "text", isRequired: false, options: [] },
      { name: "Warranty", type: "text", isRequired: false, options: [] },
    ],
    children: [
      { name: "Mobiles & Tablets", slug: "mobiles-tablets" },
      { name: "Laptops & Computers", slug: "laptops-computers" },
      { name: "Televisions", slug: "televisions" },
      { name: "Audio & Headphones", slug: "audio-headphones" },
      { name: "Cameras", slug: "cameras" },
    ],
  },
  {
    name: "Fashion",
    slug: "fashion",
    description: "Clothing, footwear and accessories for everyone",
    attributes: [
      { name: "Brand", type: "text", isRequired: false, options: [] },
      { name: "Size", type: "select", isRequired: false, options: ["XS", "S", "M", "L", "XL", "XXL"] },
      { name: "Color", type: "text", isRequired: false, options: [] },
    ],
    children: [
      { name: "Men's Clothing", slug: "mens-clothing" },
      { name: "Women's Clothing", slug: "womens-clothing" },
      { name: "Footwear", slug: "footwear" },
      { name: "Watches & Accessories", slug: "watches-accessories" },
      { name: "Bags & Luggage", slug: "bags-luggage" },
    ],
  },
  {
    name: "Home & Kitchen",
    slug: "home-kitchen",
    description: "Furniture, appliances, kitchen and decor",
    children: [
      { name: "Furniture", slug: "furniture" },
      { name: "Kitchen Appliances", slug: "kitchen-appliances" },
      { name: "Cookware & Dining", slug: "cookware-dining" },
      { name: "Home Decor", slug: "home-decor" },
    ],
  },
  {
    name: "Beauty & Personal Care",
    slug: "beauty-personal-care",
    description: "Skincare, makeup, hair care and grooming",
    children: [
      { name: "Skincare", slug: "skincare" },
      { name: "Makeup", slug: "makeup" },
      { name: "Hair Care", slug: "hair-care" },
      { name: "Fragrances", slug: "fragrances" },
    ],
  },
  {
    name: "Sports & Outdoors",
    slug: "sports-outdoors",
    description: "Fitness, outdoor gear and sports equipment",
    children: [
      { name: "Fitness & Gym", slug: "fitness-gym" },
      { name: "Outdoor & Camping", slug: "outdoor-camping" },
      { name: "Cricket", slug: "cricket" },
      { name: "Cycling", slug: "cycling" },
    ],
  },
  {
    name: "Books & Stationery",
    slug: "books-stationery",
    description: "Books, office supplies and stationery",
    children: [
      { name: "Books", slug: "books" },
      { name: "Stationery", slug: "stationery" },
      { name: "Office Supplies", slug: "office-supplies" },
    ],
  },
  {
    name: "Toys & Baby",
    slug: "toys-baby",
    description: "Toys, games and baby essentials",
    children: [
      { name: "Toys & Games", slug: "toys-games" },
      { name: "Baby Care", slug: "baby-care" },
      { name: "Kids' Furniture", slug: "kids-furniture" },
    ],
  },
];

const findOrCreateBySlug = async ({ name, slug, description = "", level = 0, parentCategory = null, attributes = [], isFeatured = false }) => {
  const existing = await Category.findOne({ slug });
  if (existing) {
    console.log(`  exists: ${slug}`);
    return existing;
  }
  const category = await Category.create({
    name,
    slug,
    description,
    level,
    parentCategory: parentCategory || null,
    attributes,
    sortOrder: 0,
    isFeatured,
  });
  console.log(`  created: ${slug}`);
  return category;
};

const seed = async () => {
  const uri = process.env.MONGODB_URI || process.env.DB_URL;
  if (!uri) {
    console.error("No MONGODB_URI / DB_URL found in Backend/.env — cannot connect.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected to MongoDB — seeding categories…");

  for (const top of CATEGORIES) {
    const parent = await findOrCreateBySlug(top);
    for (const child of top.children || []) {
      await findOrCreateBySlug({
        ...child,
        description: "",
        level: 1,
        parentCategory: parent._id,
      });
    }
  }

  const total = await Category.countDocuments();
  console.log(`Done. ${total} categories present in the database.`);
  await mongoose.disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
