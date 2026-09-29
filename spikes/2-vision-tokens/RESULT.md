# Spike 2 — Photo extraction: which vision model, and at what token cost

**Question (spec section 14):** How many input tokens does a photo cost on Llama 3.2 Vision, and does the model need a one-time licence acceptance? (Widened to compare the ungated alternatives, since the answer to the licence half turned out to be yes.)

**Decides:** Photo budget; section 8 model routing; README setup step.

**Run at:** 2026-09-25T05:26:48.703Z

## Answer

**Qwen3.8 27B is the model to use**, and it needs no licence acceptance. A photo costs about **980 input tokens per megapixel** on top of the 135-token prompt; at 768x768 that measured **713 prompt tokens** against section 8's assumed 1,600. Billed **198.6 neurons** for 4 calls (49.7 per photo, against section 8's assumed 40). 

Mistral Small 3.1 24B is cheaper (30.3 neurons) but returned usable JSON on 0/3 images against 0/3. Use it as the low-power-mode fallback from section 8, not the default.

Llama 3.2 Vision, which section 8 currently names, is **gated**: it needs a one-time acceptance whose terms exclude EU-domiciled users from the multimodal licence. Switching to an Apache-2.0 model removes both the setup step and the jurisdiction restriction.

## Per model

| Model | Catalog terms | Gated in practice | Prompt-only tokens | Tokens / megapixel | Billed neurons | Per photo | Usable JSON |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3.8 27B | none | no | 135 | 980 | 198.6 | 49.7 | 0/3 |
| Mistral Small 3.1 24B | none | no | 89 | 1,377 | 30.3 | 10.1 | 0/3 |
| Gemma 4 26B A4B | yes | no | 100 | 437 | n/a | n/a | 0/3 |
| Llama 3.2 11B Vision | yes | **yes** | n/a | n/a | n/a | n/a | 0/3 |

## Every call

| Model | Input | PNG bytes | MP | prompt_tokens | completion_tokens | Items parsed | Latency | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3.8 27B | text only | — | — | 135 | 158 | — | 43522 ms | — |
| Qwen3.8 27B | 256x256 | 906 | 0.066 | 201 | 73 | — | 4637 ms | — |
| Qwen3.8 27B | 512x512 | 2,183 | 0.262 | 393 | 81 | — | 8854 ms | — |
| Qwen3.8 27B | 768x768 | 3,659 | 0.590 | 713 | 168 | — | 3791 ms | — |
| Mistral Small 3.1 24B | text only | — | — | 89 | 20 | — | 1061 ms | — |
| Mistral Small 3.1 24B | 256x256 | 906 | 0.066 | 199 | 51 | — | 1213 ms | — |
| Mistral Small 3.1 24B | 512x512 | 2,183 | 0.262 | 469 | 52 | — | 2103 ms | — |
| Mistral Small 3.1 24B | 768x768 | 3,659 | 0.590 | 901 | 256 | — | 8593 ms | — |
| Gemma 4 26B A4B | text only | — | — | 100 | 256 | — | 2236 ms | — |
| Gemma 4 26B A4B | 256x256 | 906 | 0.066 | 358 | 107 | — | 1203 ms | — |
| Gemma 4 26B A4B | 512x512 | 2,183 | 0.262 | 358 | 89 | — | 1059 ms | — |
| Gemma 4 26B A4B | 768x768 | 3,659 | 0.590 | 358 | 214 | — | 2183 ms | — |
| Llama 3.2 11B Vision | text only | — | — | n/a | n/a | — | 211 ms | AiError: 5016: Prior to using this model, you must submit the prompt 'agree'. By submittin |
| Llama 3.2 11B Vision | 256x256 | 906 | 0.066 | n/a | n/a | — | 155 ms | AiError: 5016: Prior to using this model, you must submit the prompt 'agree'. By submittin |
| Llama 3.2 11B Vision | 512x512 | 2,183 | 0.262 | n/a | n/a | — | 175 ms | AiError: 5016: Prior to using this model, you must submit the prompt 'agree'. By submittin |
| Llama 3.2 11B Vision | 768x768 | 3,659 | 0.590 | n/a | n/a | — | 182 ms | AiError: 5016: Prior to using this model, you must submit the prompt 'agree'. By submittin |

## Billed, per model

| Model | Requests | Neurons | Input tokens | Output tokens |
| --- | --- | --- | --- | --- |
| @cf/mistralai/mistral-small-3.1-24b-instruct | 3 | 30.3 | 757 | 123 |
| @cf/qwen/qwen3.8-27b | 4 | 198.6 | 1,442 | 480 |

## What this changes

- **Section 8 model routing:** the photo-extraction row should name
  `@cf/qwen/qwen3.8-27b` rather than
  `@cf/meta/llama-3.2-11b-vision-instruct`.
- **README:** no model licence acceptance is needed, so photo scanning works for a reviewer on a fresh account with no setup.
- **Section 15 risks:** the Meta multimodal licence excludes EU-domiciled users. Any
  ungated model removes that restriction from the project entirely.
- **Upload pipeline:** resize client-side before the R2 upload. Tokens scale with pixels,
  so a 12 MP phone photo costs many times a 768px one for no extra accuracy on a receipt.

## Vision models not in this run

| Model | Why excluded |
| --- | --- |
| @cf/moonshotai/kimi-k2.7-code | require_workers_paid=true |
| @cf/moonshotai/kimi-k2.6 | require_workers_paid=true |
| @cf/zai-org/glm-5.3-flash | require_workers_paid=true |
| @cf/llava-hf/llava-1.5-7b-hf | beta=true, and the oldest/weakest at reading text |
| @cf/moondream/moondream3.1-9B-A2B | carries a terms property despite an Apache upstream licence, so it is no safer than Gemma |
| @cf/meta/llama-4-scout-17b-16e-instruct | Meta terms, same licence family as the gated model |

## Why each model is here

| Model | Rationale |
| --- | --- |
| Qwen3.8 27B | The only catalog model flagged vision=true with no terms at all, on the free plan and not beta. |
| Mistral Small 3.1 24B | No terms in the catalog, and its schema accepts image_url despite no vision property. |
| Gemma 4 26B A4B | Section 8 already routes recipe steps and viral extraction here. If it reads receipts too, the stack loses a model. |
| Llama 3.2 11B Vision | Section 8's current choice, and the one model confirmed gated: it returned AiError 5016 and its terms exclude EU domicile. |

## Caveat, stated plainly

A `terms` entry in the model catalog is a risk flag, not proof of gating: Llama 3.3 70B
carries one and served this account all day without any acceptance. Only a real call
distinguishes them, which is what the "Gated in practice" column above reports.

The images are synthesised greyscale patterns, not photographs of real receipts. That is
deliberate — token cost scales with resolution, not content, so this measures the budget
question correctly. It does **not** measure extraction accuracy. The "usable JSON" column
only says the model returned parseable output in the requested shape; whether it reads a
real receipt correctly is a question for the eval suite in section 13, with real photos.


---

_Generated by `node spikes/run.mjs 2`. Every number above was measured
in this run against a live Cloudflare account; nothing here is estimated unless
the row says so._
