import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ERROR_STATUS,
  ErrorCode,
  PantryItem,
  PostPantryRequest,
  Profile,
} from './index.js';

describe('shared schemas', () => {
  it('rejects an unknown allergen on a profile', () => {
    const base = {
      diets: ['vegan'],
      allergens: ['tree_nuts'],
      exclusions: ['mushroom'],
      cuisines: [],
      maxCookMinutes: 30,
      servings: 2,
      spiceLevel: 'medium',
      timeZone: 'Asia/Kolkata',
      updatedAt: '2026-09-23T04:00:00Z',
    };
    expect(Profile.safeParse(base).success).toBe(true);
    expect(Profile.safeParse({ ...base, allergens: ['cashew'] }).success).toBe(false);
  });

  it('accepts either shape of an add-to-pantry request', () => {
    expect(PostPantryRequest.safeParse({ text: 'bought 1kg paneer' }).success).toBe(true);
    expect(
      PostPantryRequest.safeParse({
        items: [{ displayName: 'paneer', quantity: 1, unit: 'kg' }],
      }).success,
    ).toBe(true);
    expect(PostPantryRequest.safeParse({}).success).toBe(false);
  });

  it('keeps a soft-deleted pantry item parseable, so undo still works', () => {
    const item = {
      id: 'p1',
      canonicalId: 'paneer',
      displayName: 'Paneer',
      category: 'dairy',
      quantity: 1,
      unit: 'kg',
      qtyConfidence: 'exact',
      addedAt: '2026-09-23T04:00:00Z',
      expiresAt: null,
      expirySource: 'estimated',
      source: 'chat',
      deletedAt: '2026-09-24T04:00:00Z',
    };
    expect(PantryItem.safeParse(item).success).toBe(true);
  });

  it('maps every error code to a status and parses the error body', () => {
    for (const code of ErrorCode.options) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(
      ApiError.safeParse({ error: { code: 'not_found', message: 'gone', requestId: 'r1' } })
        .success,
    ).toBe(true);
  });
});
