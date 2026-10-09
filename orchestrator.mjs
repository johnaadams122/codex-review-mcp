import process from "node:process";
import { admit } from "./admission.mjs";
import { computeRoute, CODEX_TIERS } from "./routing.mjs";
import * as jobs from "./jobs.mjs";

const OLLAMA_URL = "http://localhost:11434/api/generate";
// Local tier model. The default is qwen2.5:7b (it matched a larger model on precision in a
// small bake-off, at about twice the speed, and fits a modest GPU fully). Set
// CODEX_MCP_LOCAL_MODEL to use a different local model.
const DEFAULT_LOCAL_MODEL = "qwen2.5:7b";
const LOCAL_NUM_CTX = 32768;
const LOCAL_TIMEOUT_MS = 120_000;
const LOCAL_NUM_PREDICT = 2048;

// Named delegate qualities. Codex qualities force the codex tier (long-standing behavior:
// ANY quality used to force codex, and prose-specified callers pass quality WITHOUT tier
// and depend on that -- unknown qualities therefore still force codex). "local" is the
// exception: it forces the local Ollama tier.
const CODEX_QUALITIES = new Set(["flagship", "standard", "fast", "fast_review", "astra"]);
const LOCAL_QUALITIES = new Set(["local"]);

function qualityForcedTier(quality) {
  if (!quality) return null;
  if (LOCAL_QUALITIES.has(quality)) return "local";
  return "codex"; // known codex qualities AND unknown values: preserve forced-codex behavior
}

// The adapter discriminator -- callers can check `NORMALIZATION_ERRORS.has(reason)`
// to recognize a normalizeDelegateStrength() rejection without hardcoding the string set.
export const NORMALIZATION_ERRORS = new Set([
  "conflicting_override",
  "partial_override",
  "local_codex_conflict",
  "invalid_override",
]);

// A PRESENT raw effort must be one of these. Typo'd effort strings (e.g. "xxhigh")
// must not reach the companion; "max" never reaches normalization -- delegate() rejects
// it earlier (see the effort==="max" guard above).
const ALLOWED_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

// Input hygiene: "absent" is undefined, null, OR a string that is empty after trim().
// A present non-string value passes through unchanged (out of scope -- callers pass strings).
function presentValue(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  }
  return raw;
}

// Pure decision-table normalizer for delegate()'s quality/model/effort inputs.
// Never mutates its argument, and
// never returns a shared/mutable reference into CODEX_TIERS (every field is copied by value
// and risk_flags/error objects are fresh array/object literals per call).
export function normalizeDelegateStrength(opts = {}) {
  const tier = presentValue(opts.tier);
  const quality = presentValue(opts.quality);
  const model = presentValue(opts.model);
  const effort = presentValue(opts.effort);

  // Rows L/5: quality="local" ignores raw model/effort entirely (unchanged today) --
  // the only thing that can go wrong is an explicit tier="codex" fighting it.
  if (quality === "local") {
    if (tier === "codex") {
      return {
        ok: false,
        reason: "local_codex_conflict",
        error: 'quality="local" conflicts with tier="codex": a local request cannot be forced onto the codex tier'
      };
    }
    return {
      ok: true,
      requested_quality: "local",
      resolved_quality: "local",
      model: null,
      effort: null,
      risk_flags: []
    };
  }

  // Row V: a present raw effort must be a real value before any other rule considers it.
  // This applies in every remaining quality state (named tier, unknown, or absent) --
  // only the already-handled quality="local" path ignores raws outright.
  if (effort !== null && !ALLOWED_EFFORTS.has(effort)) {
    return {
      ok: false,
      reason: "invalid_override",
      error: `effort="${effort}" is not a valid effort; allowed values are ${[...ALLOWED_EFFORTS].join(", ")}`
    };
  }

  // Rows 1a/1b: a named codex quality. Raw model/effort must be absent or equal to the
  // row's value; a present, differing raw is a hard conflict.
  if (quality !== null && Object.prototype.hasOwnProperty.call(CODEX_TIERS, quality)) {
    const row = CODEX_TIERS[quality];
    const conflicts = [];
    if (model !== null && model !== row.model) conflicts.push(`model="${model}"`);
    if (effort !== null && effort !== row.effort) conflicts.push(`effort="${effort}"`);
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: "conflicting_override",
        error: `quality="${quality}" expects model=${row.model} effort=${row.effort}, but received ${conflicts.join(", ")}`
      };
    }
    return {
      ok: true,
      requested_quality: quality,
      resolved_quality: quality,
      model: row.model,
      effort: row.effort,
      risk_flags: []
    };
  }

  // Rows U/U+: an unknown (present, non-local, non-tier-literal) quality string.
  if (quality !== null) {
    if (model !== null || effort !== null) {
      const present = [];
      if (model !== null) present.push(`model="${model}"`);
      if (effort !== null) present.push(`effort="${effort}"`);
      return {
        ok: false,
        reason: "conflicting_override",
        error: `unknown quality="${quality}" cannot be combined with raw model/effort overrides (received ${present.join(", ")})`
      };
    }
    const standard = CODEX_TIERS.standard;
    return {
      ok: true,
      requested_quality: quality,
      resolved_quality: "standard",
      model: standard.model,
      effort: standard.effort,
      risk_flags: ["unknown_quality"]
    };
  }

  // Rows 2/3/4: no quality literal at all -- decide from the raw pair alone.
  if (model !== null && effort !== null) {
    return {
      ok: true,
      requested_quality: null,
      resolved_quality: "custom",
      model,
      effort,
      risk_flags: []
    };
  }
  if (model !== null || effort !== null) {
    return {
      ok: false,
      reason: "partial_override",
      error: "pass quality=flagship|standard|fast|fast_review|local|astra, or BOTH model and effort"
    };
  }
  const standard = CODEX_TIERS.standard;
  return {
    ok: true,
    requested_quality: null,
    resolved_quality: "standard",
    model: standard.model,
    effort: standard.effort,
    risk_flags: []
  };
}

export async function delegate(task, opts = {}) {
  // "max" is reviews-only. Reject BEFORE any routing or submission (fail-closed).
  // This raw pre-trim check stays FIRST, ahead of normalization (order pin: a caller who
  // sends effort="max" gets the reviews-only rejection, never an "invalid_override").
  if (opts.effort === "max") {
    return {
      selected_tier: "codex", reason: "max_reviews_only", risk_flags: [], write_blocked: false,
      // requested_quality is provenance on EVERY route, error
      // envelopes included -- this rejection is no exception.
      requested_quality: opts.quality ?? null,
      result: { error: "effort 'max' is reviews-only: use codex_gate or codex_review_panel" },
    };
  }

  // Trim tier ONCE at delegate() entry, same
  // presentValue hygiene normalizeDelegateStrength() already applies internally to its OWN
  // tier read (the local_codex_conflict check) -- a padded/blank raw opts.tier was
  // otherwise truthy-raw all the way to the forceTier line below, so VALID_FORCE_TIERS
  // (routing.mjs) never recognized it, the forced-tier branch silently fell through, and
  // task keywords decided the tier instead -- reopening the null-strength submit that normalization closes.
  const trimmedTier = presentValue(opts.tier);

  // Normalize quality/model/effort BEFORE admit() -- a normalization failure's message
  // contains only strength tokens (never task text), so it returns before redaction runs
  // and jobs.submitTask is never reached. Callers detect this shape via NORMALIZATION_ERRORS.
  const norm = normalizeDelegateStrength({ ...opts, tier: trimmedTier });
  if (!norm.ok) {
    return {
      selected_tier: "codex",
      reason: norm.reason,
      risk_flags: [],
      write_blocked: false,
      requested_quality: presentValue(opts.quality),
      result: { error: norm.error }
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  // The single admission gate resolves policy, blocks writes fail-closed,
  // and redacts task text AND context_snapshot before anything leaves the machine.
  const gate = admit({
    kind: "delegate", cwd,
    write: Boolean(opts.write),
    task, context_snapshot: opts.context_snapshot
  });
  const policy = gate.policy;
  // Feed qualityForcedTier() the NORMALIZED (trimmed) quality,
  // not the raw opts.quality -- a padded "quality: ' local '" normalizes as local (model/
  // effort null), but the raw string is not in LOCAL_QUALITIES, so forcing off the raw value
  // would treat it as unknown and force codex, reaching submitTask with a null model/effort
  // (reopening the config-toml fallback normalization is supposed to close). qualityForcedTier() itself
  // stays byte-untouched; null (absent/blank) still yields no forced tier, exactly as before.
  // Use the TRIMMED tier here too (not raw opts.tier) -- see the comment
  // at trimmedTier's declaration above.
  const forceTier = trimmedTier ?? qualityForcedTier(norm.requested_quality);
  // Raw write INTENT still drives routing (PII+write -> claude tier, unchanged).
  const route = computeRoute(gate.task, policy, forceTier, { write: Boolean(opts.write) });
  route.risk_flags.push(...norm.risk_flags);

  const write_blocked = gate.write_blocked;
  const effective_write = gate.effective_write;

  const full_prompt = gate.context_snapshot ? `${gate.context_snapshot}\n\n${gate.task}` : gate.task;

  let result;
  let strengthFields = {};
  if (route.tier === "local") {
    try {
      result = await callGemma(full_prompt);
    } catch (err) {
      // Ollama down/unreachable: fall back to the claude tier, but TAGGED so outages stay
      // observable -- selected_tier stays honest (claude did/will do the work, not the local model).
      route.risk_flags.push("ollama_unavailable");
      return {
        selected_tier: "claude",
        reason: "ollama_unavailable_fallback",
        risk_flags: route.risk_flags,
        write_blocked,
        requested_quality: norm.requested_quality,
        result: {
          message: "Handle inline in Claude",
          fallback_from: "local",
          error: String(err && err.message ? err.message : err)
        }
      };
    }
  } else if (route.tier === "codex") {
    // quality="local" resolves ok at
    // normalization whenever the raw tier isn't exactly "codex" -- resolved_quality
    // "local", model/effort null. An invalid truthy tier ("bogus") or a programmatic "auto"
    // (adapters map it to null, but this function must not rely on that) both fail
    // VALID_FORCE_TIERS (routing.mjs) and fall through to keyword promotion, landing HERE
    // with norm.model/norm.effort still null. Guard the INVARIANT -- delegate() must never
    // submit a codex job without an explicit strength -- not the "local" symptom, so any
    // other future path that resolves a null strength this far is caught the same way.
    // Fail closed with the SAME local_codex_conflict shape normalization already uses (reused
    // from NORMALIZATION_ERRORS, not a new reason) so both adapters hard-error automatically
    // (MCP isError via server.mjs, CLI exit 4 via cli.mjs) instead of reopening the
    // config-toml fallback with a dishonest envelope (selected_tier:"codex",
    // resolved_quality:"local").
    if (norm.model == null || norm.effort == null) {
      return {
        selected_tier: "codex",
        reason: "local_codex_conflict",
        risk_flags: [],
        write_blocked: false,
        requested_quality: norm.requested_quality,
        result: {
          error: 'quality="local" cannot execute on the codex tier: the requested tier was invalid or the task was keyword-promoted to codex -- pass tier="local" or drop quality="local"'
        }
      };
    }
    // model/effort come from the normalizer -- never undefined/blank. The
    // config-toml fallback (buildTaskArgs in jobs.mjs) is unreachable from delegate().
    const job = await jobs.submitTask(full_prompt, {
      write: effective_write,
      model: norm.model,
      effort: norm.effort,
      cwd
    });
    result = { job_id: job.job_id, status: job.status };
    strengthFields = { resolved_quality: norm.resolved_quality, model: norm.model, effort: norm.effort };
  } else {
    result = { message: "Handle inline in Claude" };
  }

  return {
    selected_tier: route.tier,
    reason: route.reason,
    risk_flags: route.risk_flags,
    write_blocked,
    requested_quality: norm.requested_quality,
    result,
    ...strengthFields
  };
}

async function callGemma(prompt) {
  const model = process.env.CODEX_MCP_LOCAL_MODEL || DEFAULT_LOCAL_MODEL;
  // Hardened payload, mirroring a typical Ollama client:
  // explicit num_ctx + top-level truncate:false so an oversize prompt fails LOUD (HTTP 400)
  // instead of being silently truncated. think: "true"|"false"|"omit" via env; default false
  // (both qwen2.5:7b and gemma4 accept the flag; "omit" drops the key for models that 400 on it).
  const body = {
    model,
    prompt,
    stream: false,
    truncate: false,
    options: { num_ctx: LOCAL_NUM_CTX, num_predict: LOCAL_NUM_PREDICT }
  };
  const thinkEnv = (process.env.CODEX_MCP_LOCAL_THINK || "false").toLowerCase();
  if (thinkEnv !== "omit") body.think = thinkEnv === "true";

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS)
  });

  if (!res.ok) {
    throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return { response: data.response, model };
}
