// Detached launcher for the API test server (used by test-api.mjs runs).
// Keeps the real server.js untouched; just sets env before importing it.
// NOTE: NODE_ENV must NOT be "test" — server.js skips startServer() in test mode.
process.env.PORT = "3001"; // forced — system env may already export PORT=3000
process.env.MONGODB_URI = "mongodb://localhost:27017/shopsphere_apitest"; // isolated test DB

await import("../server.js");
