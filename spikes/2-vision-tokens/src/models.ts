/**
 * The vision models Workers AI can serve on the free plan, and the different
 * shapes they each want their input in.
 *
 * `terms` below is read from the model catalog
 * (`/accounts/{id}/ai/models/search`, the `properties` array), not from the
 * upstream project's licence file. Two things learned the hard way:
 *
 * 1. A permissive upstream licence does not mean Cloudflare serves the model
 *    without a click-through. Moondream 3.1 is Apache upstream and still
 *    carries a `terms` property.
 * 2. A `terms` property does not prove a model is gated either. Llama 3.3 70B
 *    carries one and served thousands of requests on this account with no
 *    acceptance. Only Llama 3.2 Vision actually returned `AiError 5016`.
 *
 * So `terms` is recorded as a risk flag and the run measures the truth.
 *
 * The catalog's `vision` property is also unreliable: Mistral Small 3.1 has no
 * `vision` property but its input schema accepts `image_url`. Schema beats
 * catalog metadata, and that is what picked the shapes below.
 */

export interface VisionModel {
  id: string;
  label: string;
  /** Catalog `terms` URL, or null when the catalog lists none. */
  terms: string | null;
  /** Why this model is in the comparison. */
  rationale: string;
  withImage(png: Uint8Array, prompt: string): Record<string, unknown>;
  textOnly(prompt: string): Record<string, unknown>;
}

/** base64 without blowing the argument limit on a spread of a large array. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Schema exposes `image_url`: OpenAI-style chat content parts with a data URL. */
function chatImageModel(
  id: string,
  label: string,
  terms: string | null,
  rationale: string,
): VisionModel {
  return {
    id,
    label,
    terms,
    rationale,
    withImage: (png, prompt) => ({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${toBase64(png)}` } },
          ],
        },
      ],
      max_tokens: 256,
    }),
    textOnly: (prompt) => ({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
    }),
  };
}

/** Schema exposes a bare `image`: the legacy byte-array shape. */
function imageArrayModel(
  id: string,
  label: string,
  terms: string | null,
  rationale: string,
): VisionModel {
  return {
    id,
    label,
    terms,
    rationale,
    withImage: (png, prompt) => ({ image: Array.from(png), prompt, max_tokens: 256 }),
    textOnly: (prompt) => ({ prompt, max_tokens: 256 }),
  };
}

export const MODELS: VisionModel[] = [
  chatImageModel(
    '@cf/qwen/qwen3.8-27b',
    'Qwen3.8 27B',
    null,
    'The only catalog model flagged vision=true with no terms at all, on the free plan and not beta.',
  ),
  chatImageModel(
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
    'Mistral Small 3.1 24B',
    null,
    'No terms in the catalog, and its schema accepts image_url despite no vision property.',
  ),
  chatImageModel(
    '@cf/google/gemma-4-26b-a4b-it',
    'Gemma 4 26B A4B',
    'https://ai.google.dev/gemma/docs/gemma_4_license',
    'Section 8 already routes recipe steps and viral extraction here. If it reads receipts too, the stack loses a model.',
  ),
  imageArrayModel(
    '@cf/meta/llama-3.2-11b-vision-instruct',
    'Llama 3.2 11B Vision',
    'https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE',
    "Section 8's current choice, and the one model confirmed gated: it returned AiError 5016 and its terms exclude EU domicile.",
  ),
];

/**
 * Vision-capable models excluded from the run, with the reason, so the result
 * can say what was considered rather than implying these four are all there is.
 */
export const EXCLUDED: { id: string; reason: string }[] = [
  { id: '@cf/moonshotai/kimi-k2.7-code', reason: 'require_workers_paid=true' },
  { id: '@cf/moonshotai/kimi-k2.6', reason: 'require_workers_paid=true' },
  { id: '@cf/zai-org/glm-5.3-flash', reason: 'require_workers_paid=true' },
  { id: '@cf/llava-hf/llava-1.5-7b-hf', reason: 'beta=true, and the oldest/weakest at reading text' },
  {
    id: '@cf/moondream/moondream3.1-9B-A2B',
    reason: 'carries a terms property despite an Apache upstream licence, so it is no safer than Gemma',
  },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', reason: 'Meta terms, same licence family as the gated model' },
];
