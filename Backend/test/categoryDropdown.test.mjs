import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import {
  SHEET_TABS,
  CATEGORY_HEADERS,
  PRODUCT_HEADERS,
} from "../services/sheetTabs.js";
import {
  resolveCategoryName,
} from "../services/googleSheetsServices.js";
import {
  resolveCategoryId,
} from "../services/sheetSync.js";
import Category from "../models/Category.js";

// ---------------------------------------------------------------------------
// Category Tab & Headers Contract
// ---------------------------------------------------------------------------

test("SHEET_TABS includes categories tab", () => {
  assert.equal(SHEET_TABS.categories, "Categories");
  assert.equal(SHEET_TABS.products, "Products");
  assert.equal(SHEET_TABS.orders, "Orders");
  assert.equal(SHEET_TABS.inventory, "Inventory");
});

test("CATEGORY_HEADERS matches schema [categoryId, categoryName]", () => {
  assert.deepEqual(CATEGORY_HEADERS, ["categoryId", "categoryName"]);
});

test("PRODUCT_HEADERS category column is at index 8 (Column I)", () => {
  assert.equal(PRODUCT_HEADERS[8], "category");
  assert.equal(PRODUCT_HEADERS.indexOf("category"), 8);
});

// ---------------------------------------------------------------------------
// Category Export — resolveCategoryName
// ---------------------------------------------------------------------------

test("resolveCategoryName returns category name from populated object", async () => {
  const result = await resolveCategoryName({ _id: "66abc1234567890123456789", name: "Electronics" });
  assert.equal(result, "Electronics");
});

test("resolveCategoryName returns category name when given plain string", async () => {
  const result = await resolveCategoryName("Electronics");
  assert.equal(result, "Electronics");
});

test("resolveCategoryName returns empty string for null / undefined", async () => {
  assert.equal(await resolveCategoryName(null), "");
  assert.equal(await resolveCategoryName(undefined), "");
  assert.equal(await resolveCategoryName(""), "");
});

// ---------------------------------------------------------------------------
// Category Import — resolveCategoryId & Database Resolution
// ---------------------------------------------------------------------------

test("resolveCategoryId returns null for empty or whitespace-only inputs", async () => {
  assert.equal(await resolveCategoryId(""), null);
  assert.equal(await resolveCategoryId("   "), null);
  assert.equal(await resolveCategoryId(null), null);
  assert.equal(await resolveCategoryId(undefined), null);
});

// Mocked / In-Memory Category Tests for resolveCategoryId and resolveCategoryName
test("resolveCategoryId matches active category by name case-insensitively when DB connected", async () => {
  const originalFindOne = Category.findOne;
  const mockCategoryId = new mongoose.Types.ObjectId("66abc1234567890123456789");

  // Mock Category.findOne
  Category.findOne = (query) => ({
    select: () => ({
      lean: async () => {
        if (query.name && query.name.test("electronics")) {
          return { _id: mockCategoryId, name: "Electronics", isActive: true };
        }
        return null;
      },
    }),
  });

  // Temporarily set readyState to 1 to simulate connected MongoDB
  const originalState = mongoose.connection.readyState;
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });

  try {
    const matchedId = await resolveCategoryId("  Electronics  ");
    assert.deepEqual(matchedId, mockCategoryId);

    const lowercaseMatchedId = await resolveCategoryId("electronics");
    assert.deepEqual(lowercaseMatchedId, mockCategoryId);

    const invalidId = await resolveCategoryId("Electronics123");
    assert.equal(invalidId, null);
  } finally {
    Category.findOne = originalFindOne;
    Object.defineProperty(mongoose.connection, "readyState", { value: originalState, configurable: true });
  }
});

test("resolveCategoryId matches active category by slug when DB connected", async () => {
  const originalFindOne = Category.findOne;
  const mockCategoryId = new mongoose.Types.ObjectId("66abc1234567890123456780");

  Category.findOne = (query) => ({
    select: () => ({
      lean: async () => {
        if (query.slug === "home-kitchen") {
          return { _id: mockCategoryId, name: "Home & Kitchen", slug: "home-kitchen", isActive: true };
        }
        return null;
      },
    }),
  });

  const originalState = mongoose.connection.readyState;
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });

  try {
    const matchedId = await resolveCategoryId("Home & Kitchen");
    assert.deepEqual(matchedId, mockCategoryId);
  } finally {
    Category.findOne = originalFindOne;
    Object.defineProperty(mongoose.connection, "readyState", { value: originalState, configurable: true });
  }
});

test("resolveCategoryId rejects non-existent or inactive categories", async () => {
  const originalFindOne = Category.findOne;

  Category.findOne = () => ({
    select: () => ({
      lean: async () => null,
    }),
  });

  const originalState = mongoose.connection.readyState;
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });

  try {
    const result = await resolveCategoryId("Unknown Category XYZ");
    assert.equal(result, null);
  } finally {
    Category.findOne = originalFindOne;
    Object.defineProperty(mongoose.connection, "readyState", { value: originalState, configurable: true });
  }
});

test("resolveCategoryName finds category name by ObjectId when DB connected", async () => {
  const originalFindById = Category.findById;
  const mockCategoryId = new mongoose.Types.ObjectId("66abc1234567890123456789");

  Category.findById = (id) => ({
    select: () => ({
      lean: async () => {
        if (String(id) === String(mockCategoryId)) {
          return { _id: mockCategoryId, name: "Electronics" };
        }
        return null;
      },
    }),
  });

  const originalState = mongoose.connection.readyState;
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });

  try {
    const name = await resolveCategoryName(mockCategoryId);
    assert.equal(name, "Electronics");

    const nameFromHex = await resolveCategoryName(mockCategoryId.toString());
    assert.equal(nameFromHex, "Electronics");
  } finally {
    Category.findById = originalFindById;
    Object.defineProperty(mongoose.connection, "readyState", { value: originalState, configurable: true });
  }
});
