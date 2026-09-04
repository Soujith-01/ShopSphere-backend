// ---------------------------------------------------------------------------
// Product text normalization + embedding text builder
// Pure functions — easily unit-testable without a DB or Gemini.
// ---------------------------------------------------------------------------

// Normalize either:
//  - the request body of POST /api/ai/product-description
//  - a Product mongoose document (plain or populated)
// into one canonical shape used for prompts and embedding text.
export function normalizeAIProductFields(src) {
  const out = {
    name: "",
    brand: "",
    category: "",
    description: "",
    sellingPoints: [],
    attributes: [], // [{ name, value }]
    features: [],
    tags: [],
    variants: [], // [{ label, sku, options }]
  };
  if (!src || typeof src !== "object") return out;

  out.name = typeof src.name === "string" ? src.name.trim() : "";

  // Brand: top-level field, or inside attributes
  if (typeof src.brand === "string" && src.brand.trim()) {
    out.brand = src.brand.trim();
  }

  // Category: string, or populated Category doc
  if (typeof src.category === "string" && src.category.trim()) {
    out.category = src.category;
  } else if (src.category && typeof src.category === "object" && typeof src.category.name === "string") {
    out.category = src.category.name;
  }

  out.description =
    typeof src.description === "string"
      ? src.description.trim()
      : typeof src.aiDescription === "string"
        ? src.aiDescription.trim()
        : "";

  const sellingPoints = Array.isArray(src.sellingPoints) ? src.sellingPoints : src.aiSellingPoints;
  if (Array.isArray(sellingPoints)) {
    out.sellingPoints = sellingPoints.filter((s) => typeof s === "string" && s.trim());
  }

  // Attributes: [{name,value}] or { key: value }
  if (Array.isArray(src.attributes)) {
    out.attributes = src.attributes
      .map((a) =>
        a && typeof a === "object"
          ? { name: String(a.name ?? "").trim(), value: String(a.value ?? "").trim() }
          : null
      )
      .filter((a) => a && a.name && a.value);
  } else if (src.attributes && typeof src.attributes === "object") {
    out.attributes = Object.entries(src.attributes)
      .map(([name, value]) => ({ name, value: String(value ?? "").trim() }))
      .filter((a) => a.value);
  }

  // Brand fallback from attributes
  if (!out.brand) {
    const brandAttr = out.attributes.find((a) => a.name.toLowerCase() === "brand");
    if (brandAttr) out.brand = brandAttr.value;
  }

  if (Array.isArray(src.features)) {
    out.features = src.features.filter((f) => typeof f === "string" && f.trim());
  }
  if (Array.isArray(src.tags)) {
    out.tags = src.tags.filter((t) => typeof t === "string" && t.trim());
  }

  if (Array.isArray(src.variants)) {
    out.variants = src.variants
      .filter((v) => v && (v.label || v.sku))
      .map((v) => ({
        label: v.label || "",
        sku: v.sku || "",
        options: v.options || {},
      }));
  }

  return out;
}

// Build the embedding text for a product (normalized shape).
// The richer the text, the better semantic matches are.
export function buildProductEmbeddingText(product) {
  const p = normalizeAIProductFields(product);
  const parts = [];

  if (p.name) parts.push(`Product: ${p.name}`);
  if (p.brand) parts.push(`Brand: ${p.brand}`);
  if (p.category) parts.push(`Category: ${p.category}`);
  if (p.description) parts.push(`Description: ${p.description}`);
  if (p.sellingPoints.length) parts.push(`Selling points: ${p.sellingPoints.join(", ")}`);
  if (p.attributes.length) {
    parts.push(`Attributes: ${p.attributes.map((a) => `${a.name}: ${a.value}`).join(", ")}`);
  }
  if (p.features.length) parts.push(`Features: ${p.features.join(", ")}`);
  if (p.tags.length) parts.push(`Tags: ${p.tags.join(", ")}`);
  if (p.variants.length) {
    parts.push(
      `Variants: ${p.variants.map((v) => (v.label ? `${v.label}${v.sku ? ` (${v.sku})` : ""}` : v.sku)).join(", ")}`
    );
  }

  return parts.join("\n");
}