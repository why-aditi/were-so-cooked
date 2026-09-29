import type { TasteMemory } from '@cooked/shared';

/**
 * Taste memory and its search (sections 4 and 5).
 *
 * Section 4 is explicit about why this is not in Vectorize: "Taste memory
 * stays in each agent's SQLite instead of Vectorize. Each user has at most
 * 300 short memories, so a brute-force search is cheap, and it keeps per-user
 * data out of a shared index."
 *
 * So the search is a loop over at most 300 float arrays. At 1024 dimensions
 * that is 300K multiply-adds, which is well inside a Worker's 10ms CPU limit
 * and costs nothing per query — a Vectorize round trip would cost both
 * latency and a shared index holding one user's dislikes.
 *
 * The arithmetic is pure and lives here; the storage and the embedding call
 * live on the agent.
 */

/** Section 4's ceiling. The oldest memory is evicted past this. */
export const MAX_MEMORIES = 300;

/** Section 5's context slot: "Top 5 memories most similar to the message". */
export const TOP_K = 5;

/** `@cf/baai/bge-m3`, confirmed 1024 in spike 1. */
export const EMBEDDING_DIMENSIONS = 1024;

export interface StoredMemory extends TasteMemory {
  /** Null when the embedding call failed; such a row is text-searchable only. */
  embedding: Float32Array | null;
}

export interface ScoredMemory {
  memory: StoredMemory;
  score: number;
}

/**
 * Cosine similarity.
 *
 * bge-m3 returns normalised vectors, so a dot product would usually do — but
 * "usually" is doing load-bearing work in that sentence, and dividing by the
 * norms costs one pass over an array of 1024 floats. Normalising here means a
 * future model swap cannot silently skew every ranking.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The top `k` memories most similar to a query vector.
 *
 * Brute force, deliberately — see the note at the top of the file. Memories
 * without an embedding are skipped rather than scored zero: a failed
 * embedding call should make a memory invisible to semantic search, not rank
 * it last in every result.
 */
export function search(
  query: Float32Array,
  memories: StoredMemory[],
  k = TOP_K,
  minScore = 0.3,
): ScoredMemory[] {
  const scored: ScoredMemory[] = [];
  for (const memory of memories) {
    if (!memory.embedding) continue;
    const score = cosine(query, memory.embedding);
    if (score < minScore) continue;
    scored.push({ memory, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt))
    .slice(0, k);
}

/**
 * Renders the taste slot for the context window.
 *
 * Kinds are labelled rather than listed raw, because "mushrooms" alone tells
 * a model nothing about whether to cook with them or avoid them.
 */
export function renderTaste(results: ScoredMemory[]): string[] {
  return results.map(({ memory }) => {
    const prefix =
      memory.kind === 'like' ? 'likes' : memory.kind === 'dislike' ? 'dislikes' : 'note';
    return `${prefix}: ${memory.text}`;
  });
}

/**
 * The dislikes handed to `check` as soft violations (section 7).
 *
 * Only the `dislike` kind, and only the subject — a dislike lowers a ranking
 * and must never become a safety decision, which is why section 7 gives it
 * its own severity. A note or a like has no business in this list.
 */
export function dislikesFrom(memories: StoredMemory[]): string[] {
  return memories
    .filter((m) => m.kind === 'dislike' && m.subject !== null)
    .map((m) => m.subject as string);
}

/* ------------------------------ serialisation ----------------------------- */

/**
 * Float32Array to bytes for SQLite.
 *
 * A BLOB rather than JSON: 1024 floats are 4KB packed against roughly 20KB as
 * text, and 300 of those is the difference between 1.2MB and 6MB of storage
 * per user, read in full on every search.
 */
export function packEmbedding(vector: Float32Array): ArrayBuffer {
  // `slice()` because a Float32Array view may sit on a larger buffer, and
  // storing the whole backing buffer would silently write the neighbours too.
  return vector.slice().buffer as ArrayBuffer;
}

export function unpackEmbedding(blob: ArrayBuffer | Uint8Array | null): Float32Array | null {
  if (!blob) return null;
  const buffer = blob instanceof Uint8Array ? bufferOf(blob) : blob;
  if (buffer.byteLength % 4 !== 0) return null;
  return new Float32Array(buffer);
}

/** A Uint8Array from SQLite may be a view; copy so the offsets line up. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}
