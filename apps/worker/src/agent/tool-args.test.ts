import { describe, expect, it } from 'vitest';
import { SuggestArgs, UpdateArgs } from './tools.js';

/**
 * The tool argument schemas against what Llama 3.3 actually sends: numbers as
 * strings, and `null` or `""` in optional fields it did not mean to set.
 */

describe('numeric tool arguments', () => {
  it('accepts a number sent as a string', () => {
    // Production: suggest_recipes {"query": "", "count": "4"}.
    expect(SuggestArgs.parse({ query: '', count: '4' })).toEqual({ query: '', count: 4 });
  });

  it('reads null and "" as not given — never as zero', () => {
    // A rename that also sends quantity: null must leave the quantity alone.
    // z.coerce.number() turned it into 0 and would have emptied the item.
    const rename = UpdateArgs.parse({ id: 'p1', display_name: 'paneer', quantity: null });
    expect(rename).toEqual({ id: 'p1', display_name: 'paneer' });
    expect(rename.quantity).toBeUndefined();
    expect(UpdateArgs.parse({ id: 'p1', quantity: '' })).toEqual({ id: 'p1' });
  });

  it('still rejects anything that is not a number', () => {
    for (const quantity of [false, 'x', [], {}, '1kg']) {
      expect(UpdateArgs.safeParse({ id: 'p1', quantity }).success).toBe(false);
    }
  });

  it('keeps the bounds', () => {
    expect(UpdateArgs.safeParse({ id: 'p1', quantity: '-1' }).success).toBe(false);
    expect(SuggestArgs.safeParse({ query: '', count: '99' }).success).toBe(false);
    expect(UpdateArgs.parse({ id: 'p1', quantity: '2.5' })).toEqual({ id: 'p1', quantity: 2.5 });
  });
});
