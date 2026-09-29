import { describe, expect, it } from 'vitest';
import { MODEL_RATES, UNKNOWN_MODEL_RATE, neuronsFor, rateFor } from './rates.js';

const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * The Llama 3.3 70B rates were solved from three calls Cloudflare billed on
 * 2026-09-25 (spike 4). This asserts they still reproduce all three.
 *
 * It is a real check, not a tautology: three measurements and two unknowns is
 * overdetermined, and the calls differ in input/output ratio by a factor of
 * roughly ten. A wrong pair cannot fit all three at once, so editing a rate
 * fails here rather than silently skewing every reservation in the app.
 */
describe('measured rates reproduce the billed figures', () => {
  const cases = [
    { name: '3 chat turns', promptTokens: 7_176, completionTokens: 121, billed: 214.9 },
    { name: 'plan generate (2 calls)', promptTokens: 5_234, completionTokens: 1_219, billed: 384.5 },
    { name: 'plan repair', promptTokens: 1_173, completionTokens: 94, billed: 50.5 },
  ];

  it.each(cases)('$name within 2% of $billed neurons', ({ promptTokens, completionTokens, billed }) => {
    const computed = neuronsFor(LLAMA, { promptTokens, completionTokens });
    expect(Math.abs(computed - billed) / billed).toBeLessThan(0.02);
  });

  it('prices a single chat turn near the 71.6 neurons measured in spike 4', () => {
    const one = neuronsFor(LLAMA, { promptTokens: 2_392, completionTokens: 40 });
    expect(one).toBeGreaterThan(70);
    expect(one).toBeLessThan(74);
  });
});

describe('cost arithmetic', () => {
  it('scales linearly with tokens', () => {
    const single = neuronsFor(LLAMA, { promptTokens: 1_000, completionTokens: 100 });
    const double = neuronsFor(LLAMA, { promptTokens: 2_000, completionTokens: 200 });
    expect(double).toBeCloseTo(single * 2, 6);
  });

  it('charges output far more than input, which is why estimates go wrong', () => {
    const inputHeavy = neuronsFor(LLAMA, { promptTokens: 1_000, completionTokens: 0 });
    const outputHeavy = neuronsFor(LLAMA, { promptTokens: 0, completionTokens: 1_000 });
    expect(outputHeavy / inputHeavy).toBeGreaterThan(7);
  });

  it('is zero for a call that used no tokens', () => {
    expect(neuronsFor(LLAMA, { promptTokens: 0, completionTokens: 0 })).toBe(0);
  });
});

describe('unknown models fail closed', () => {
  it('prices an unrecognised model at the most expensive known rate', () => {
    const probe = { promptTokens: 1_000, completionTokens: 1_000 };
    const unknown = neuronsFor('@cf/some/model-we-have-never-seen', probe);
    const dearest = Math.max(...Object.keys(MODEL_RATES).map((m) => neuronsFor(m, probe)));
    expect(unknown).toBeGreaterThanOrEqual(dearest);
    expect(rateFor('@cf/some/model-we-have-never-seen')).toBe(UNKNOWN_MODEL_RATE);
  });

  it('never prices an unknown model below any model in the table', () => {
    // Overstating is safe; understating lets the account overrun.
    const probe = { promptTokens: 1_000, completionTokens: 500 };
    const unknown = neuronsFor('@cf/nope', probe);
    for (const model of Object.keys(MODEL_RATES)) {
      expect(unknown).toBeGreaterThanOrEqual(neuronsFor(model, probe) - 1e-9);
    }
  });
});

describe('provenance is recorded, not assumed', () => {
  it('marks only Llama 3.3 70B as a solved split rate', () => {
    const split = Object.entries(MODEL_RATES).filter(([, r]) => r.source === 'measured-split');
    expect(split.map(([m]) => m)).toEqual([LLAMA]);
  });

  it('gives every rate a note explaining where it came from', () => {
    for (const [model, rate] of Object.entries(MODEL_RATES)) {
      expect(rate.note, `${model} has no provenance note`).toBeTruthy();
      expect(rate.inputPerMillion).toBeGreaterThan(0);
      expect(rate.outputPerMillion).toBeGreaterThan(0);
    }
  });

  it('flags the 8B model as an estimate, since no call has ever been billed', () => {
    expect(rateFor('@cf/meta/llama-3.1-8b-instruct-fp8-fast').source).toBe('estimate');
  });
});
