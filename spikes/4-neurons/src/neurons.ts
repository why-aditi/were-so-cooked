/**
 * Published per-model rates, used only as a cross-check. The authoritative
 * figure is the billed one from `_lib/usage.ts`.
 */

const PRICING_URL = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';

export { readUsage, usageDelta } from '../../_lib/usage.js';
export type { ModelUsage, UsageSnapshot } from '../../_lib/usage.js';

export interface PublishedRate {
  inputNeuronsPerMillion: number | null;
  outputNeuronsPerMillion: number | null;
  note: string;
}

/**
 * Cross-check only. The billed figure above is authoritative; this exists so a
 * run can say whether Cloudflare's published rate explains what it was charged.
 */
export async function fetchPublishedRate(model: string): Promise<PublishedRate> {
  try {
    const res = await fetch(PRICING_URL, { headers: { accept: 'text/html' } });
    if (!res.ok) {
      return {
        inputNeuronsPerMillion: null,
        outputNeuronsPerMillion: null,
        note: `pricing page returned ${res.status}`,
      };
    }
    const html = await res.text();
    const slug = model.replace(/^@cf\//, '');
    const idx = html.indexOf(slug);
    if (idx === -1) {
      return {
        inputNeuronsPerMillion: null,
        outputNeuronsPerMillion: null,
        note: `"${slug}" not found on the pricing page`,
      };
    }
    const window = html.slice(idx, idx + 3000).replace(/<[^>]+>/g, ' ');
    const matches = [...window.matchAll(/([\d,]+)\s*neurons per M (input|output) tokens/gi)];
    const input = matches.find((m) => m[2]?.toLowerCase() === 'input');
    const output = matches.find((m) => m[2]?.toLowerCase() === 'output');
    return {
      inputNeuronsPerMillion: input ? Number(input[1]?.replace(/,/g, '')) : null,
      outputNeuronsPerMillion: output ? Number(output[1]?.replace(/,/g, '')) : null,
      note: input || output ? `read from ${PRICING_URL}` : 'no neuron rows matched near the model',
    };
  } catch (e) {
    return {
      inputNeuronsPerMillion: null,
      outputNeuronsPerMillion: null,
      note: `pricing fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
