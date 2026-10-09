// strength.mjs -- reviewer strength (tier) ranking, shared by panel + gate.
//
// Kept dependency-light (only routing.mjs) to avoid a panel<->gate import cycle: both import it.
//
// EXACT-MATCH ONLY. A { model, effort } pair earns a named tier's rank ONLY when it exactly
// equals a CODEX_TIERS entry. Every other pair (cross combos like sol/medium, an unknown model, a
// missing effort) resolves to "unknown" = rank 0 and therefore fails ANY real floor. There is no
// "nearest tier" notion -- that would be a fail-OPEN guess.

import { CODEX_TIERS, MAX_STRENGTH } from "./routing.mjs";

// astra ranks above flagship (a strictly more capable, more expensive model) but below the
// privileged sol/max direct-exec transport, which is a distinct mechanism, not "best model".
const RANK = { max: 5, astra: 4, flagship: 3, standard: 2, fast_review: 1.5, fast: 1, unknown: 0 };

export function tierOf({ model, effort } = {}) {
  if (model === MAX_STRENGTH.model && effort === MAX_STRENGTH.effort) return "max";
  for (const [name, t] of Object.entries(CODEX_TIERS)) {
    if (t.model === model && t.effort === effort) return name;
  }
  return "unknown";
}

// Own-property lookup ONLY: a name colliding with an Object.prototype member (e.g. "constructor")
// must rank 0, never return an inherited function that would poison the < comparison into NaN.
export function tierRank(name) { return Object.prototype.hasOwnProperty.call(RANK, name) ? RANK[name] : 0; }

// "Below floor" == the strength's tier rank is strictly less than the floor tier's rank. An
// unknown/custom pair (rank 0) is ALWAYS below any real named floor -- fail CLOSED.
export function belowFloor(strength, floorName) {
  return tierRank(tierOf(strength)) < tierRank(floorName);
}
