import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Section 10: "All text meets WCAG AA contrast."
 *
 * A claim like that rots the moment someone nudges a hex value to make a
 * card look better, and nothing in a browser complains. So the palette is
 * read straight out of index.css and every foreground/background pair the
 * design actually uses is checked here.
 *
 * Reading the CSS rather than duplicating the values is the point: a token
 * changed in one place and not the other would make this test pass while
 * the app fails.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../index.css', import.meta.url)),
  'utf8',
);

/** The value of a custom property, from the first block that defines it. */
function token(name: string, scope?: string): string {
  // Every rule matching the selector, not just the first: the light theme
  // declares its surfaces in one block and its accents in another. Slicing
  // "everything after the selector" instead walks into the dark values
  // declared below and checks the wrong colour while passing.
  const pattern = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`);

  if (!scope) {
    const match = pattern.exec(CSS);
    if (!match?.[1]) throw new Error(`No hex value for ${name}`);
    return match[1];
  }

  for (let at = CSS.indexOf(scope); at !== -1; at = CSS.indexOf(scope, at + 1)) {
    const open = CSS.indexOf('{', at);
    const close = CSS.indexOf('}', open);
    if (open === -1 || close === -1) break;
    const match = pattern.exec(CSS.slice(open, close));
    if (match?.[1]) return match[1];
  }

  throw new Error(`No hex value for ${name} in ${scope}`);
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/* --------------------------------- palette -------------------------------- */

const dark = {
  page: token('--color-braise'),
  raised: token('--color-tin'),
  text: token('--color-chalk'),
  muted: token('--color-chalk-dim'),
  ink: token('--color-ink'),
  marigold: token('--color-marigold'),
  chilli: token('--color-chilli'),
  mint: token('--color-mint'),
  warn: token('--text-warn', ":root[data-theme='dark'] {\n  --text-warn"),
};

const LIGHT_BLOCK = ":root[data-theme='light']";

/* ---------------------------------- tests --------------------------------- */

/** AA for body text. */
const AA_TEXT = 4.5;
/** AA for a border, a focus ring or a meter fill against what it sits on. */
const AA_NON_TEXT = 3;

describe('dark theme contrast', () => {
  it.each([
    ['body text on the page', dark.text, dark.page],
    ['body text on a card', dark.text, dark.raised],
    ['muted text on the page', dark.muted, dark.page],
    ['muted text on a card', dark.muted, dark.raised],
  ])('%s clears AA', (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps button labels readable on every accent fill', () => {
    // Buttons put ink on marigold and on chilli, so those are text pairs
    // and need the full 4.5, not the 3:1 a decorative fill would.
    expect(contrast(dark.ink, dark.marigold)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(dark.ink, dark.chilli)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps the focus ring visible against the page', () => {
    expect(contrast(dark.marigold, dark.page)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('keeps the budget meter fills distinguishable from their track', () => {
    expect(contrast(dark.mint, dark.raised)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrast(dark.chilli, dark.raised)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('gives the warn accent more headroom than the raw chilli', () => {
    // Chilli itself clears AA on a card (5.3:1), so this is not a rescue —
    // --text-warn exists so warning prose is comfortably clear of the
    // threshold rather than sitting just above it.
    expect(contrast(dark.warn, dark.raised)).toBeGreaterThan(contrast(dark.chilli, dark.raised));
    expect(contrast(dark.warn, dark.raised)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('light theme contrast', () => {
  const page = token('--surface-page', LIGHT_BLOCK);
  const raised = token('--surface-raised', LIGHT_BLOCK);
  const text = token('--text-primary', LIGHT_BLOCK);
  const muted = token('--text-muted', LIGHT_BLOCK);

  it.each([
    ['body text on the page', text, page],
    ['body text on a card', text, raised],
    ['muted text on the page', muted, page],
  ])('%s clears AA', (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each([
    ['warn', '--text-warn'],
    ['go', '--text-go'],
    ['act', '--text-act'],
    ['work', '--text-work'],
  ])('the %s accent clears AA as text', (_name, name) => {
    expect(contrast(token(name, LIGHT_BLOCK), raised)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('darkens the focus ring, because marigold on paper is invisible', () => {
    expect(contrast(dark.marigold, page)).toBeLessThan(AA_NON_TEXT);
    expect(contrast('#8a5a00', page)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe('the stylesheet itself', () => {
  it('defines a light theme for every semantic token the dark theme has', () => {
    const names = [...CSS.matchAll(/(--(?:surface|text)-[a-z]+):/g)].map((m) => m[1] as string);
    const lightBlock = CSS.slice(CSS.indexOf(LIGHT_BLOCK), CSS.indexOf('@layer base'));
    for (const name of [...new Set(names)]) {
      expect(lightBlock, `${name} has no light-theme value`).toContain(`${name}:`);
    }
  });

  it('respects prefers-reduced-motion', () => {
    expect(CSS).toContain('prefers-reduced-motion: reduce');
  });

  it('keeps a visible focus style', () => {
    expect(CSS).toContain(':focus-visible');
  });
});
