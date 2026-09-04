#!/usr/bin/env node
/**
 * Prints the MongoDB Atlas Vector Search index definition required for
 * semantic search on Product.aiEmbedding.
 *
 * The `dimensions` value MUST match GEMINI_EMBEDDING_DIMENSIONS in .env:
 *   - text-embedding-004  → 768   (default)
 *   - gemini-embedding-001 → 3072
 *
 * How to create it (manual, one-time):
 *   1. Atlas → your cluster → "Atlas Search" → "Create Search Index"
 *   2. Choose "JSON Editor" and paste the definition printed below
 *   3. Name it exactly "product_embedding_index" (or set ATLAS_VECTOR_INDEX_NAME in .env)
 */
import { config } from "dotenv";
config();

const dimensions =
  Number(process.env.GEMINI_EMBEDDING_DIMENSIONS) ||
  (process.env.GEMINI_EMBEDDING_MODEL?.includes("gemini-embedding-001") ? 3072 : 768);

const indexName = process.env.ATLAS_VECTOR_INDEX_NAME || "product_embedding_index";

const definition = {
  mappings: {
    dynamic: false,
    fields: {
      aiEmbedding: {
        type: "knnVector",
        dimensions,
        similarity: "cosine",
      },
    },
  },
};

console.log(`\nAtlas Vector Search index: "${indexName}"  (dimensions: ${dimensions})\n`);
console.log(JSON.stringify(definition, null, 2));
console.log(`
Embedding model : ${process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004 (default)"}
IMPORTANT: dimensions must match GEMINI_EMBEDDING_DIMENSIONS in .env exactly.
`);