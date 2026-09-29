/**
 * Per-model neuron rates, used to turn a call's token usage into a cost.
 *
 * Section 12: "A caller reserves an estimate, makes the AI call, then commits
 * the actual cost, computed from the returned token counts and the per-model
 * rates in config."
 *
 * Provenance matters here, so every rate carries it. Two kinds:
 *
 *   split    separate input and output rates, solved from two or more measured
 *            calls with different in/out ratios. Only Llama 3.3 70B has enough
 *            independent measurements for this.
 *   blended  one rate over (input + output), derived from a single measured
 *            call. Correct only near that call's in/out ratio, so it is a
 *            working figure and not a fact about the model.
 *
 * Why this distinction is not pedantry: output bills at roughly 7.7x input on
 * Llama 3.3 70B. A blended rate applied to a call with a very different ratio
 * can be wrong by several times, in either direction. The estimate is what
 * gets reserved, so a bad one either blocks a call that would have fit or
 * admits one that overruns.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type RateSource = 'measured-split' | 'measured-blended' | 'estimate';

export interface ModelRate {
  /** Neurons per million input tokens. */
  inputPerMillion: number;
  /** Neurons per million output tokens. */
  outputPerMillion: number;
  source: RateSource;
  note: string;
}

/**
 * Solved from three measured calls on 2026-09-25 (spike 4), each billed by
 * Cloudflare rather than derived:
 *
 *   3 chat turns    7,176 in /   121 out -> 214.9 neurons
 *   plan generate   5,234 in / 1,219 out -> 384.5 neurons
 *   plan repair     1,173 in /    94 out ->  50.5 neurons
 *
 * Three equations, two unknowns. These rates reproduce all three to within
 * 1.2%, which is a real cross-check: a wrong pair cannot fit calls whose in/out
 * ratio differs by a factor of ten. `rates.test.ts` asserts that fit, so
 * editing a rate breaks a test rather than silently skewing every reservation.
 */
const LLAMA_33_70B: ModelRate = {
  inputPerMillion: 26_668,
  outputPerMillion: 204_805,
  source: 'measured-split',
  note: 'Solved from three billed calls, spike 4; largest residual 1.2%.',
};

/** Turns a single observed call into a blended rate applied to total tokens. */
function blended(neurons: number, inTokens: number, outTokens: number, note: string): ModelRate {
  const perMillion = (neurons / (inTokens + outTokens)) * 1_000_000;
  return {
    inputPerMillion: perMillion,
    outputPerMillion: perMillion,
    source: 'measured-blended',
    note,
  };
}

export const MODEL_RATES: Record<string, ModelRate> = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': LLAMA_33_70B,

  // Single billed observation each, from spike 2's vision comparison on
  // 2026-09-25. Enough to size a reservation, not enough to split.
  '@cf/qwen/qwen3.8-27b': blended(199, 1_442, 480, 'Spike 2: 4 calls, 199 neurons.'),
  '@cf/google/gemma-4-26b-a4b-it': blended(29, 1_174, 666, 'Spike 2: 4 calls, 29 neurons.'),
  '@cf/mistralai/mistral-small-3.1-24b-instruct': blended(
    72,
    1_658,
    379,
    'Spike 2: 4 calls, 72 neurons.',
  ),
  '@cf/baai/bge-m3': blended(4, 4_145, 0, 'Spike 1: 78 embedding calls, 4 neurons.'),

  // Never returned a billed call — every attempt during the spikes hit the
  // rate limit. Section 8 estimates ~10 neurons for 600/200 tokens; that is
  // encoded here as a split rate in the same proportion as the 70B model so it
  // is at least the right shape. Replace on first real measurement.
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': {
    inputPerMillion: 3_000,
    outputPerMillion: 23_000,
    source: 'estimate',
    note: 'No billed observation yet. Shaped from section 8 (600/200 -> ~10 neurons).',
  },
};

/**
 * Used for a model with no entry: the worst known rate on each axis, so an
 * unrecognised model overstates its cost rather than quietly overrunning the
 * account cap. Failing closed on budget is the same instinct as failing closed
 * on allergens.
 *
 * Computed rather than hardcoded to Llama 3.3 70B, which was the first attempt
 * and was wrong — Qwen3.8's blended rate is higher per input token, so an
 * unknown model would have been *under*priced on input-heavy calls. A test
 * pins the property: nothing in the table may cost more than this.
 */
export const UNKNOWN_MODEL_RATE: ModelRate = {
  inputPerMillion: Math.max(...Object.values(MODEL_RATES).map((r) => r.inputPerMillion)),
  outputPerMillion: Math.max(...Object.values(MODEL_RATES).map((r) => r.outputPerMillion)),
  source: 'estimate',
  note: 'Unknown model; priced at the worst known rate on each axis.',
};

export function rateFor(model: string): ModelRate {
  return MODEL_RATES[model] ?? UNKNOWN_MODEL_RATE;
}

/** The cost of one call, in neurons. */
export function neuronsFor(model: string, usage: TokenUsage): number {
  const rate = rateFor(model);
  return (
    (usage.promptTokens / 1_000_000) * rate.inputPerMillion +
    (usage.completionTokens / 1_000_000) * rate.outputPerMillion
  );
}
