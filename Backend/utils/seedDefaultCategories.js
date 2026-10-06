import Category from "../models/Category.js";

const DEFAULT_CATEGORIES = [
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

export async function autoSeedCategoriesIfEmpty() {
  try {
    const count = await Category.countDocuments();
    if (count > 0) return;

    console.log("[Categories] No categories found in database. Auto-seeding default categories…");

    for (const top of DEFAULT_CATEGORIES) {
      let parent = await Category.findOne({ slug: top.slug });
      if (!parent) {
        parent = await Category.create({
          name: top.name,
          slug: top.slug,
          description: top.description || "",
          level: 0,
          parentCategory: null,
          attributes: top.attributes || [],
          sortOrder: 0,
          isActive: true,
        });
      }

      for (const child of top.children || []) {
        const existingChild = await Category.findOne({ slug: child.slug });
        if (!existingChild) {
          await Category.create({
            name: child.name,
            slug: child.slug,
            description: "",
            level: 1,
            parentCategory: parent._id,
            attributes: [],
            sortOrder: 0,
            isActive: true,
          });
        }
      }
    }

    const newCount = await Category.countDocuments();
    console.log(`[Categories] Auto-seeding completed. ${newCount} categories available.`);
  } catch (err) {
    console.error("⚠️ [Categories] Auto-seeding failed:", err.message);
  }
}
