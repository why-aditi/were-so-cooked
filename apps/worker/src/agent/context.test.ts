import type { PantryItem, Profile } from '@cooked/shared';
import { describe, expect, it } from 'vitest';
import {
  SLOT_CAPS,
  buildContext,
  estimateTokens,
  renderPantry,
  renderProfile,
  type ChatMessage,
} from './context.js';

/**
 * The context window from section 5.
 *
 * The failure this guards against is silent: when a slot overflows, nothing
 * errors — the model just stops seeing the oldest half of the conversation, or
 * the end of the allergy list.
 */

const NOW = Date.parse('2026-09-26T12:00:00Z');

const profile = (over: Partial<Profile> = {}): Profile => ({
  diets: [],
  allergens: [],
  exclusions: [],
  cuisines: [],
  maxCookMinutes: 45,
  servings: 2,
  spiceLevel: 'medium',
  timeZone: 'Asia/Kolkata',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

let seq = 0;
const item = (over: Partial<PantryItem> = {}): PantryItem => {
  seq += 1;
  return {
    id: `p${seq}`,
    canonicalId: 'paneer',
    displayName: 'paneer',
    category: 'dairy',
    quantity: 500,
    unit: 'g',
    qtyConfidence: 'exact',
    addedAt: '2026-09-20T00:00:00.000Z',
    expiresAt: null,
    expirySource: 'estimated',
    source: 'chat',
    deletedAt: null,
    ...over,
  };
};

const base = {
  system: 'system prompt',
  profile: profile(),
  pantry: [],
  history: [] as ChatMessage[],
  message: 'what can i make',
  now: NOW,
};

/* -------------------------------- profile --------------------------------- */

describe('the profile slot', () => {
  it('always states the allergens, even when there are none', () => {
    // "allergens: none" and a missing line read the same to a model that has
    // seen a thousand truncated prompts. Say it.
    expect(renderProfile(profile())).toContain('allergens: none');
  });

  it('puts allergens first', () => {
    const text = renderProfile(
      profile({ allergens: ['peanuts'], diets: ['vegan'], exclusions: ['mushroom'] }),
    );
    expect(text.split('\n')[0]).toBe('allergens: peanuts');
  });

  it('fits in its cap with every field populated', () => {
    const text = renderProfile(
      profile({
        allergens: ['peanuts', 'tree_nuts', 'milk', 'egg', 'soy', 'gluten'],
        diets: ['vegetarian', 'gluten_free', 'halal'],
        exclusions: ['mushroom', 'okra', 'bitter gourd'],
        cuisines: ['indian', 'thai', 'italian', 'lebanese'],
      }),
    );
    expect(estimateTokens(text)).toBeLessThan(SLOT_CAPS.profile);
  });
});

/* --------------------------------- pantry ---------------------------------- */

describe('the pantry slot', () => {
  it('says so plainly when the pantry is empty', () => {
    expect(renderPantry([], NOW)).toBe('pantry: empty');
  });

  it('names what is going off and counts the rest', () => {
    const text = renderPantry(
      [
        item({ displayName: 'palak', expiresAt: '2026-09-27T12:00:00Z', category: 'produce' }),
        item({ displayName: 'rice', expiresAt: '2028-01-01T00:00:00Z', category: 'grains' }),
        item({ displayName: 'atta', expiresAt: null, category: 'grains' }),
      ],
      NOW,
    );
    expect(text).toContain('- palak 500g (tomorrow)');
    expect(text).not.toContain('- rice');
    expect(text).toContain('3 items total');
    expect(text).toContain('grains 2');
  });

  it('reads an already-expired item as today rather than a negative', () => {
    const text = renderPantry([item({ expiresAt: '2026-09-24T12:00:00Z' })], NOW);
    expect(text).toContain('(today)');
    expect(text).not.toContain('-2d');
  });

  it('ignores soft-deleted rows', () => {
    const text = renderPantry([item({ deletedAt: '2026-09-25T00:00:00Z' })], NOW);
    expect(text).toBe('pantry: empty');
  });

  it('stays inside 600 tokens with a pantry nobody should have', () => {
    // 400 items, every one of them expiring. This is the case that would
    // silently eat the conversation if the cap were not enforced.
    const many = Array.from({ length: 400 }, (_, i) =>
      item({ displayName: `ingredient number ${i}`, expiresAt: '2026-09-27T00:00:00Z' }),
    );
    const built = buildContext({ ...base, pantry: many });
    const slot = built.slots.find((s) => s.name === 'pantry');
    expect(slot?.tokens).toBeLessThanOrEqual(SLOT_CAPS.pantry);
  });
});

/* -------------------------------- assembly --------------------------------- */

describe('assembling a turn', () => {
  it('puts the context in the system message and the question last', () => {
    const built = buildContext({ ...base, pantry: [item()] });
    expect(built.messages[0]?.role).toBe('system');
    expect(built.messages[0]?.content).toContain('--- pantry ---');
    expect(built.messages.at(-1)).toEqual({ role: 'user', content: 'what can i make' });
  });

  it('leaves out slots that have nothing in them', () => {
    const built = buildContext(base);
    expect(built.messages[0]?.content).not.toContain('what they like');
  });

  it('keeps short history whole', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey 🍳' },
    ];
    const built = buildContext({ ...base, history });
    expect(built.messages.slice(1, 3)).toEqual(history);
    expect(built.droppedMessages).toBe(0);
  });

  it('trims history from the oldest, never the newest', () => {
    // Section 5: "Most recent messages, trimmed from the oldest." The last
    // thing said is what the new message refers to.
    const history: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${i} `.padEnd(400, 'x'),
    }));
    const built = buildContext({ ...base, history });

    expect(built.droppedMessages).toBeGreaterThan(0);
    const kept = built.messages.slice(1, -1);
    expect(kept.at(-1)?.content).toBe(history.at(-1)?.content);
    expect(kept[0]?.content).not.toBe(history[0]?.content);
  });

  it('stays under the 6K turn budget even when everything is oversized', () => {
    const built = buildContext({
      ...base,
      system: 'x'.repeat(40_000),
      profile: profile({ exclusions: Array.from({ length: 300 }, (_, i) => `thing ${i}`) }),
      pantry: Array.from({ length: 500 }, () => item({ expiresAt: '2026-09-27T00:00:00Z' })),
      taste: Array.from({ length: 200 }, (_, i) => `likes thing ${i}`),
      history: Array.from({ length: 500 }, () => ({
        role: 'user' as const,
        content: 'y'.repeat(2_000),
      })),
    });
    expect(built.estimatedTokens).toBeLessThanOrEqual(SLOT_CAPS.total);
  });

  it('still produces a usable turn when history cannot fit at all', () => {
    const built = buildContext({
      ...base,
      history: [{ role: 'user', content: 'z'.repeat(80_000) }],
    });
    expect(built.droppedMessages).toBe(1);
    // System and the question survive; the turn is degraded, not broken.
    expect(built.messages).toHaveLength(2);
    expect(built.messages.at(-1)?.content).toBe('what can i make');
  });

  it('caps each slot at the section 5 figure', () => {
    const built = buildContext({
      ...base,
      system: 'x'.repeat(40_000),
      taste: ['t'.repeat(40_000)],
    });
    for (const slot of built.slots) {
      expect(slot.tokens, slot.name).toBeLessThanOrEqual(slot.cap);
    }
  });
});
