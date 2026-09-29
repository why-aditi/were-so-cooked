import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  MAX_MEMORIES,
  type StoredMemory,
  cosine,
  dislikesFrom,
  packEmbedding,
  renderTaste,
  search,
  unpackEmbedding,
} from './taste.js';

/**
 * Taste memory search (sections 4, 5 and 7).
 *
 * Section 4 keeps this out of Vectorize because 300 short memories is a
 * cheap brute-force scan. That only holds if the scan is correct, and the
 * part with teeth is `dislikesFrom`: a dislike must reach `check` as a soft
 * signal and never as a hard rule.
 */

let n = 0;
const memory = (over: Partial<StoredMemory> = {}): StoredMemory => {
  n += 1;
  return {
    id: `m${n}`,
    text: `memory ${n}`,
    kind: 'note',
    subject: null,
    recipeId: null,
    weight: 1,
    createdAt: `2026-09-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`,
    embedding: null,
    ...over,
  };
};

const vec = (...values: number[]): Float32Array => new Float32Array(values);

/* -------------------------------- cosine ---------------------------------- */

describe('cosine similarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosine(vec(1, 2, 3), vec(1, 2, 3))).toBeCloseTo(1, 6);
  });

  it('ignores magnitude, which is the point of normalising', () => {
    // bge-m3 returns normalised vectors today. Dividing by the norms anyway
    // means a future model swap cannot silently skew every ranking.
    expect(cosine(vec(1, 0, 0), vec(10, 0, 0))).toBeCloseTo(1, 6);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosine(vec(1, 0), vec(0, 1))).toBe(0);
  });

  it('is negative for opposed vectors', () => {
    expect(cosine(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1, 6);
  });

  it('returns 0 rather than NaN for a zero vector', () => {
    // A division by zero here would poison a sort with NaN and silently
    // scramble the ranking instead of failing.
    expect(cosine(vec(0, 0), vec(1, 1))).toBe(0);
  });

  it('returns 0 for mismatched lengths instead of reading past the end', () => {
    expect(cosine(vec(1, 2, 3), vec(1, 2))).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosine(new Float32Array(0), new Float32Array(0))).toBe(0);
  });
});

/* -------------------------------- search ---------------------------------- */

describe('searching memories', () => {
  const near = memory({ text: 'loves paneer', embedding: vec(1, 0, 0) });
  const middling = memory({ text: 'likes rice', embedding: vec(0.7, 0.7, 0) });
  const far = memory({ text: 'hates okra', embedding: vec(0, 0, 1) });

  it('ranks the closest memory first', () => {
    const results = search(vec(1, 0, 0), [far, middling, near]);
    expect(results[0]?.memory.text).toBe('loves paneer');
    expect(results[0]?.score).toBeCloseTo(1, 6);
  });

  it('drops anything below the relevance floor', () => {
    // An unrelated memory in the context slot is worse than an empty slot:
    // it spends tokens and invites the model to act on it.
    const results = search(vec(1, 0, 0), [far]);
    expect(results).toEqual([]);
  });

  it('returns at most k', () => {
    const many = Array.from({ length: 20 }, () => memory({ embedding: vec(1, 0, 0) }));
    expect(search(vec(1, 0, 0), many, 5)).toHaveLength(5);
  });

  it('skips memories whose embedding failed rather than ranking them last', () => {
    const noVector = memory({ text: 'unembedded', embedding: null });
    const results = search(vec(1, 0, 0), [noVector, near]);
    expect(results.map((r) => r.memory.text)).toEqual(['loves paneer']);
  });

  it('breaks a score tie on recency', () => {
    const older = memory({ text: 'older', embedding: vec(1, 0, 0), createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = memory({ text: 'newer', embedding: vec(1, 0, 0), createdAt: '2026-09-01T00:00:00.000Z' });
    expect(search(vec(1, 0, 0), [older, newer])[0]?.memory.text).toBe('newer');
  });

  it('handles an empty store', () => {
    expect(search(vec(1, 0, 0), [])).toEqual([]);
  });
});

/* ------------------------------- rendering -------------------------------- */

describe('the taste slot', () => {
  it('labels each memory by kind', () => {
    // "mushrooms" alone tells a model nothing about whether to cook with them.
    const lines = renderTaste([
      { memory: memory({ text: 'paneer', kind: 'like' }), score: 1 },
      { memory: memory({ text: 'okra', kind: 'dislike' }), score: 0.9 },
      { memory: memory({ text: 'prefers less oil', kind: 'note' }), score: 0.8 },
    ]);
    expect(lines).toEqual(['likes: paneer', 'dislikes: okra', 'note: prefers less oil']);
  });
});

/* ------------------------------- dislikes --------------------------------- */

describe('dislikes handed to the safety engine', () => {
  it('takes only the dislikes', () => {
    const memories = [
      memory({ kind: 'like', subject: 'paneer' }),
      memory({ kind: 'dislike', subject: 'okra' }),
      memory({ kind: 'note', subject: 'salt' }),
    ];
    expect(dislikesFrom(memories)).toEqual(['okra']);
  });

  it('skips a dislike with no subject to match on', () => {
    // "too spicy last time" is about a dish, not an ingredient. Passing the
    // prose to `check` would match nothing, or worse, match something.
    const memories = [
      memory({ kind: 'dislike', subject: null, text: 'too spicy last time' }),
      memory({ kind: 'dislike', subject: 'okra' }),
    ];
    expect(dislikesFrom(memories)).toEqual(['okra']);
  });

  it('is empty when there are no dislikes', () => {
    expect(dislikesFrom([memory({ kind: 'like', subject: 'paneer' })])).toEqual([]);
  });
});

/* ----------------------------- serialisation ------------------------------ */

describe('storing an embedding', () => {
  it('round-trips a vector through a BLOB', () => {
    const original = vec(0.5, -0.25, 0.125);
    const restored = unpackEmbedding(packEmbedding(original));
    expect(Array.from(restored as Float32Array)).toEqual([0.5, -0.25, 0.125]);
  });

  it('round-trips a full-size bge-m3 vector', () => {
    const original = new Float32Array(EMBEDDING_DIMENSIONS).map((_, i) => i / 1024);
    const restored = unpackEmbedding(packEmbedding(original));
    expect(restored?.length).toBe(EMBEDDING_DIMENSIONS);
    expect(cosine(original, restored as Float32Array)).toBeCloseTo(1, 6);
  });

  it('copies rather than storing a view onto a larger buffer', () => {
    // A Float32Array view would otherwise write its neighbours into the BLOB.
    const backing = new Float32Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);
    const restored = unpackEmbedding(packEmbedding(view));
    expect(Array.from(restored as Float32Array)).toEqual([1, 2, 3]);
  });

  it('reads back null for a missing embedding', () => {
    expect(unpackEmbedding(null)).toBeNull();
  });

  it('rejects a BLOB that is not a whole number of floats', () => {
    expect(unpackEmbedding(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('accepts a Uint8Array, which is what SQLite hands back', () => {
    const packed = new Uint8Array(packEmbedding(vec(1, 2)));
    expect(Array.from(unpackEmbedding(packed) as Float32Array)).toEqual([1, 2]);
  });
});

describe('the section 4 ceiling', () => {
  it('is 300 memories', () => {
    expect(MAX_MEMORIES).toBe(300);
  });

  it('stays cheap to scan at that size', () => {
    // The whole argument for not using Vectorize. 300 x 1024 floats scored
    // in well under the 10ms CPU limit.
    const memories = Array.from({ length: MAX_MEMORIES }, () =>
      memory({ embedding: new Float32Array(EMBEDDING_DIMENSIONS).fill(0.03) }),
    );
    const started = Date.now();
    search(new Float32Array(EMBEDDING_DIMENSIONS).fill(0.03), memories);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
