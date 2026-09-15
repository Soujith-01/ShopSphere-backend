/**
 * Phase 8 — conflict handling for the sheet ↔ MongoDB product sync.
 *
 * Stock and price exist in two places, and both sides can move:
 *   - the seller edits a cell in their Google Sheet (stock 20 → 25), and
 *   - the application sells something (MongoDB stock 20 → 18 and the sheet
 *     mirror is written back).
 *
 * Rule (see docs/GOOGLE_SHEETS_SYNC.md):
 *   - Only the sheet moved  → the seller's edit is intentional, the sheet wins.
 *   - Only MongoDB moved    → a purchase/cancellation/restock the sheet hasn't
 *                             caught up with, MongoDB wins and the sheet is
 *                             corrected (a failed mirror can therefore heal
 *                             itself on the next cycle).
 *   - Both moved            → conflict. MongoDB wins, because a purchase is real
 *                             money and a sheet edit is usually based on the
 *                             stale number the seller was looking at. The sheet
 *                             is then rewritten with the truth.
 *   - No baseline recorded   → legacy rows (written before baselines existed);
 *                              the sheet stays authoritative, which is the
 *                              original import behaviour.
 *
 * Everything here is pure so the rule can be unit-tested without a database or
 * a Google account (see test/sheetSync.test.mjs).
 */

export const SHEET = "sheet";
export const MONGO = "mongo";

/**
 * Coerce a sheet cell into a number.
 * @returns {number|null} null for blank / non-numeric cells (treated as "no edit").
 */
export function readSheetNumber(raw) {
  if (raw === undefined || raw === null) return null;

  // Sheets hands numbers back as numbers and hand-typed cells as strings.
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  const text = String(raw).trim();
  if (!text) return null;

  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Decide which side owns one sheet-backed number.
 *
 * @param {object} input
 * @param {number|null} input.sheetValue value currently in the sheet cell
 * @param {number} input.mongoValue value currently in MongoDB
 * @param {number|null} [input.baseline] value both sides were last reconciled to
 * @returns {{winner: "sheet"|"mongo", value: number, conflict: boolean, stale: boolean}}
 *   `conflict` — both sides changed since the baseline (logged as a conflict).
 *   `stale`    — MongoDB wins although the sheet differs, so the sheet row must
 *                be rewritten from MongoDB.
 */
export function resolveFieldConflict({ sheetValue, mongoValue, baseline }) {
  const base = Number.isFinite(baseline) ? baseline : null;

  // Blank / invalid cell → nothing to import, MongoDB keeps its value.
  if (!Number.isFinite(sheetValue)) {
    return { winner: MONGO, value: mongoValue, conflict: false, stale: false };
  }

  // Both sides already agree → nothing to do.
  if (sheetValue === mongoValue) {
    return { winner: MONGO, value: mongoValue, conflict: false, stale: false };
  }

  // No baseline (legacy row) → sheet is the source of truth.
  if (base === null) {
    return { winner: SHEET, value: sheetValue, conflict: false, stale: false };
  }

  const sheetChanged = sheetValue !== base;
  const mongoChanged = mongoValue !== base;

  // Both moved → conflict, and the application's value (a real purchase) wins.
  if (sheetChanged && mongoChanged) {
    return { winner: MONGO, value: mongoValue, conflict: true, stale: true };
  }

  // Only the seller edited the sheet → their edit becomes the new value.
  if (sheetChanged) {
    return { winner: SHEET, value: sheetValue, conflict: false, stale: false };
  }

  // Only MongoDB moved → a purchase/cancel the sheet still needs to hear about.
  return { winner: MONGO, value: mongoValue, conflict: false, stale: true };
}

/**
 * Resolve a list of fields at once, keeping only the ones the caller should
 * write to MongoDB and the ones that must be pushed back to the sheet.
 *
 * @param {Array<{field: string, sheet: number|null, mongo: number, baseline?: number|null}>} fields
 * @returns {{changes: object, stale: Array, conflicts: Array}}
 */
export function resolveFieldConflicts(fields = []) {
  const changes = {};
  const stale = [];
  const conflicts = [];

  for (const entry of fields) {
    const decision = resolveFieldConflict({
      sheetValue: entry.sheet,
      mongoValue: entry.mongo,
      baseline: entry.baseline,
    });

    if (decision.winner === SHEET && decision.value !== entry.mongo) {
      changes[entry.field] = decision.value;
      continue;
    }

    if (decision.stale) {
      const detail = { field: entry.field, sheet: entry.sheet, mongo: entry.mongo };
      stale.push(detail);
      if (decision.conflict) conflicts.push(detail);
    }
  }

  return { changes, stale, conflicts };
}

export default resolveFieldConflict;
