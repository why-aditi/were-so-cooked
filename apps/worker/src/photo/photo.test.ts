import { createTaxonomy, type Taxonomy } from '@cooked/safety';
import type { Ingredient } from '@cooked/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  EXTRACT_MODEL,
  LOW_CONFIDENCE,
  type VisionRunner,
  extractItems,
  parseExtraction,
  parsePrintedDate,
} from './extract.js';
import { confirmPhrase, normalizeScan, selectedItems } from './scan.js';
import {
  MAX_UPLOAD_BYTES,
  sniffImageType,
  uploadKey,
  userIdFromKey,
  validateUpload,
} from './validate.js';

/**
 * The photo pipeline's pure parts (section 6).
 *
 * The low-confidence path lives here: section 6 says "items below 0.5
 * confidence are shown unticked", and that rule plus the taxonomy-miss rule
 * decide what a user is nudged into adding to their pantry without reading.
 */

/* -------------------------------- fixtures -------------------------------- */

const ing = (canonicalId: string, name: string, aliases: string[] = []): Ingredient => ({
  canonicalId,
  name,
  aliases,
  category: 'other',
  defaultUnit: 'g',
  defaultShelfDays: 7,
  allergens: [],
  dietFlags: [],
});

const TAXONOMY: Taxonomy = createTaxonomy([
  ing('paneer', 'paneer', ['panir']),
  ing('milk', 'milk', ['doodh']),
  ing('egg', 'egg', ['anda']),
  ing('tomato', 'tomato', ['tamatar']),
]);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

const item = (over: Record<string, unknown> = {}) => ({
  name: 'paneer',
  quantity: 200,
  unit: 'g' as const,
  confidence: 0.9,
  expires_at: null,
  ...over,
});

/* ------------------------------- validation ------------------------------- */

describe('upload validation', () => {
  it('accepts the three allowed types', () => {
    expect(validateUpload(JPEG)).toMatchObject({ ok: true, type: 'image/jpeg', extension: 'jpg' });
    expect(validateUpload(PNG)).toMatchObject({ ok: true, type: 'image/png', extension: 'png' });
    expect(validateUpload(WEBP)).toMatchObject({ ok: true, type: 'image/webp', extension: 'webp' });
  });

  it('rejects a PDF wearing a .jpg name', () => {
    // The whole reason the type is sniffed rather than read from the header.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(validateUpload(pdf)).toMatchObject({ ok: false });
  });

  it('rejects a WAV, which also starts with RIFF', () => {
    // `RIFF` alone is shared with WAV and AVI. The `WEBP` at offset 8 is
    // what actually distinguishes them.
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(validateUpload(new Uint8Array(0))).toMatchObject({ ok: false });
  });

  it('enforces the 5 MB limit and says the actual size', () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(JPEG);
    const result = validateUpload(big);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('5 MB');
  });

  it('accepts a file exactly at the limit', () => {
    const exact = new Uint8Array(MAX_UPLOAD_BYTES);
    exact.set(JPEG);
    expect(validateUpload(exact).ok).toBe(true);
  });

  it('rejects a truncated header rather than reading past the end', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });
});

describe('upload keys', () => {
  it('follows the section 4 layout', () => {
    expect(uploadKey('user-1', 'jpg', 'abc')).toBe('uploads/user-1/abc.jpg');
  });

  it('round-trips the user id', () => {
    expect(userIdFromKey(uploadKey('user-1', 'jpg'))).toBe('user-1');
  });

  it('refuses a key shaped like someone else is being addressed', () => {
    // A Workflow re-checks this: the key is the one parameter that names
    // another user's data if it is ever wrong.
    // Anything that is not exactly `uploads/<id>/<file>` is refused, so a
    // traversal attempt reads as no user rather than as a plausible one.
    expect(userIdFromKey('uploads/../other/x.jpg')).toBeNull();
    expect(userIdFromKey('other/user-1/x.jpg')).toBeNull();
    expect(userIdFromKey('uploads/x.jpg')).toBeNull();
    expect(userIdFromKey('uploads//x.jpg')).toBeNull();
  });
});

/* -------------------------------- extraction ------------------------------ */

const vision = (...replies: string[]): VisionRunner => {
  let i = 0;
  return vi.fn(async () => ({
    text: replies[Math.min(i++, replies.length - 1)] ?? '',
    usage: { promptTokens: 713, completionTokens: 120 },
  }));
};

describe('reading the vision reply', () => {
  it('accepts clean JSON', () => {
    const out = parseExtraction(JSON.stringify({ items: [item()] }));
    expect(out.ok).toBe(true);
    expect(out.ok && out.items[0]?.name).toBe('paneer');
  });

  it('digs JSON out of a markdown fence', () => {
    const out = parseExtraction('```json\n' + JSON.stringify({ items: [item()] }) + '\n```');
    expect(out.ok).toBe(true);
  });

  it('accepts a bare array when the model forgot the wrapper', () => {
    const out = parseExtraction(JSON.stringify([item()]));
    expect(out.ok).toBe(true);
  });

  it('defaults the optional fields', () => {
    const out = parseExtraction(JSON.stringify({ items: [{ name: 'paneer', confidence: 0.8 }] }));
    expect(out.ok).toBe(true);
    expect(out.ok && out.items[0]).toMatchObject({ quantity: null, unit: null, expires_at: null });
  });

  it('accepts an empty list, which is the right answer for a photo of a wall', () => {
    const out = parseExtraction(JSON.stringify({ items: [] }));
    expect(out.ok).toBe(true);
    expect(out.ok && out.items).toEqual([]);
  });

  it('rejects a confidence outside 0..1', () => {
    const out = parseExtraction(JSON.stringify({ items: [item({ confidence: 4 })] }));
    expect(out.ok).toBe(false);
  });

  it('rejects prose', () => {
    expect(parseExtraction('I see some paneer and two eggs.').ok).toBe(false);
  });
});

describe('the extract step', () => {
  it('uses the model spike 2 chose', async () => {
    const run = vision(JSON.stringify({ items: [item()] }));
    await extractItems(JPEG, { vision: run });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ model: EXTRACT_MODEL }));
  });

  it('reports the tokens, which is what the budget commit needs', async () => {
    const out = await extractItems(JPEG, { vision: vision(JSON.stringify({ items: [item()] })) });
    expect(out.usage).toEqual({ promptTokens: 713, completionTokens: 120 });
  });

  it('retries once with the error appended', async () => {
    const run = vision('not json', JSON.stringify({ items: [item()] }));
    const out = await extractItems(JPEG, { vision: run });
    expect(out.attempts).toBe(2);
    expect(out.items).toHaveLength(1);
    const retry = (run as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].prompt;
    expect(retry).toContain('previous reply was rejected');
  });

  it('returns nothing rather than throwing after the second failure', async () => {
    // The Workflow then parks on an empty confirm list, which the user can
    // close. Better than a retried step burning three more vision calls.
    const out = await extractItems(JPEG, { vision: vision('nope', 'still nope') });
    expect(out.items).toEqual([]);
    expect(out.error).toBeTruthy();
    expect(out.usage.promptTokens).toBe(1426);
  });

  it('survives the model throwing', async () => {
    const out = await extractItems(JPEG, {
      vision: vi.fn(async () => {
        throw new Error('AiError 3040');
      }),
    });
    expect(out.items).toEqual([]);
    expect(out.error).toContain('3040');
  });
});

/* ------------------------------ printed dates ----------------------------- */

describe('a date printed on the packaging', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');

  it('accepts an unambiguous ISO date', () => {
    expect(parsePrintedDate('2026-12-25', now)).toBe('2026-12-25T00:00:00.000Z');
  });

  it('rejects an ambiguous format rather than guessing', () => {
    // 03/04/2026 is March or April depending on where the packet was
    // printed, and a wrong answer here is marked `label` — presented to the
    // user as a fact rather than an estimate.
    expect(parsePrintedDate('03/04/2026', now)).toBeNull();
    expect(parsePrintedDate('25 Dec 2026', now)).toBeNull();
    expect(parsePrintedDate('Dec 2026', now)).toBeNull();
  });

  it('rejects a date that does not exist', () => {
    // `Date.UTC` would roll this into March rather than failing.
    expect(parsePrintedDate('2026-02-31', now)).toBeNull();
    expect(parsePrintedDate('2026-13-01', now)).toBeNull();
  });

  it('rejects a misread far in the future', () => {
    expect(parsePrintedDate('2099-01-01', now)).toBeNull();
  });

  it('accepts a date already past, because that is worth telling the user', () => {
    expect(parsePrintedDate('2026-01-01', now)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('handles null and whitespace', () => {
    expect(parsePrintedDate(null, now)).toBeNull();
    expect(parsePrintedDate('   ', now)).toBeNull();
    expect(parsePrintedDate(' 2026-12-25 ', now)).toBe('2026-12-25T00:00:00.000Z');
  });
});

/* --------------------------- the low-confidence path ---------------------- */

describe('building the confirm list', () => {
  it('ticks a confident, resolvable item', async () => {
    const { items } = await normalizeScan([item({ confidence: 0.9 })], TAXONOMY);
    expect(items[0]).toMatchObject({ canonicalId: 'paneer', selected: true });
  });

  it('leaves a low-confidence item unticked but present', async () => {
    // Section 6: "Items below 0.5 confidence are shown unticked." Shown, not
    // dropped — a doubtful read costs a tap, a dropped one costs the item.
    const { items } = await normalizeScan([item({ confidence: 0.3 })], TAXONOMY);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ canonicalId: 'paneer', selected: false, confidence: 0.3 });
  });

  it('treats exactly 0.5 as confident', async () => {
    const { items } = await normalizeScan([item({ confidence: LOW_CONFIDENCE })], TAXONOMY);
    expect(items[0]?.selected).toBe(true);
  });

  it('leaves a confident but unresolvable item unticked', async () => {
    // The model can be certain it read "xyzzy paste" correctly; that says
    // nothing about whether we know what is in it, and section 7 treats an
    // unresolved ingredient as a hard violation for anyone with an allergy.
    const { items, unresolved } = await normalizeScan(
      [item({ name: 'xyzzy paste', confidence: 0.99 })],
      TAXONOMY,
    );
    expect(items[0]).toMatchObject({ canonicalId: null, selected: false });
    expect(unresolved).toEqual(['xyzzy paste']);
  });

  it('resolves a romanized Hindi name through the taxonomy', async () => {
    const { items } = await normalizeScan([item({ name: 'tamatar' })], TAXONOMY);
    expect(items[0]).toMatchObject({ canonicalId: 'tomato', name: 'tomato', selected: true });
  });

  it('calls the model once for every miss, not once per miss', async () => {
    const classify = vi.fn(async () => ({ 'amul taaza': 'milk', 'xyzzy': null }));
    const { items, modelCalled } = await normalizeScan(
      [item({ name: 'amul taaza' }), item({ name: 'xyzzy' }), item({ name: 'paneer' })],
      TAXONOMY,
      { classify },
    );
    expect(classify).toHaveBeenCalledTimes(1);
    expect(modelCalled).toBe(true);
    expect(items[0]?.canonicalId).toBe('milk');
    expect(items[1]?.canonicalId).toBeNull();
  });

  it('does not call the model when the taxonomy matched everything', async () => {
    const classify = vi.fn(async () => ({}));
    const { modelCalled } = await normalizeScan([item()], TAXONOMY, { classify });
    expect(classify).not.toHaveBeenCalled();
    expect(modelCalled).toBe(false);
  });

  it('discards a canonical id the model invented', async () => {
    // A hallucinated id would carry another ingredient's allergen set.
    const classify = vi.fn(async () => ({ 'amul taaza': 'not_a_real_id' }));
    const { items, unresolved } = await normalizeScan(
      [item({ name: 'amul taaza' })],
      TAXONOMY,
      { classify },
    );
    expect(items[0]?.canonicalId).toBeNull();
    expect(items[0]?.selected).toBe(false);
    expect(unresolved).toEqual(['amul taaza']);
  });

  it('survives a classifier that throws', async () => {
    const { items, unresolved } = await normalizeScan([item({ name: 'amul taaza' })], TAXONOMY, {
      classify: vi.fn(async () => {
        throw new Error('out of budget');
      }),
    });
    expect(items).toHaveLength(1);
    expect(unresolved).toEqual(['amul taaza']);
  });

  it('carries a printed expiry through', async () => {
    const now = Date.parse('2026-09-28T00:00:00Z');
    const { items } = await normalizeScan([item({ expires_at: '2026-10-05' })], TAXONOMY, { now });
    expect(items[0]?.expiresAt).toBe('2026-10-05T00:00:00.000Z');
  });

  it('drops an unreadable printed expiry rather than inventing one', async () => {
    const { items } = await normalizeScan([item({ expires_at: 'best before soon' })], TAXONOMY);
    expect(items[0]?.expiresAt).toBeNull();
  });

  it('handles a photo with no food in it', async () => {
    const { items, unresolved } = await normalizeScan([], TAXONOMY);
    expect(items).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});

describe('committing the ticked items', () => {
  it('keeps only what is ticked', () => {
    const items = [
      { name: 'a', canonicalId: null, quantity: null, unit: null, confidence: 1, expiresAt: null, selected: true },
      { name: 'b', canonicalId: null, quantity: null, unit: null, confidence: 1, expiresAt: null, selected: false },
    ];
    expect(selectedItems(items).map((i) => i.name)).toEqual(['a']);
  });

  it('rebuilds a phrase the pantry normalizer understands', () => {
    expect(confirmPhrase({ name: 'paneer', quantity: 200, unit: 'g' })).toBe('200g paneer');
    expect(confirmPhrase({ name: 'eggs', quantity: 6, unit: null })).toBe('6 eggs');
    expect(confirmPhrase({ name: 'palak', quantity: null, unit: null })).toBe('palak');
  });
});
