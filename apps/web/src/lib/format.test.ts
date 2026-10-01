import { describe, expect, it } from 'vitest';
import { formatAmount, formatQuantity } from './format';

describe('formatAmount', () => {
  it('reads the way the first live pantry card should have', () => {
    // It printed "1kg paneer", "6piece egg" and "1bunch coriander leaves".
    expect(formatAmount(1, 'kg', 'paneer')).toBe('1 kg paneer');
    expect(formatAmount(6, 'piece', 'egg')).toBe('6 eggs');
    expect(formatAmount(1, 'bunch', 'coriander leaves')).toBe('1 bunch coriander leaves');
  });

  it('pluralises counted things and their units, not metric ones', () => {
    expect(formatAmount(1, 'piece', 'onion')).toBe('1 onion');
    expect(formatAmount(3, 'piece', 'tomato')).toBe('3 tomatoes');
    expect(formatAmount(2, 'bunch', 'spinach')).toBe('2 bunches spinach');
    expect(formatAmount(2, 'cup', 'rice')).toBe('2 cups rice');
    expect(formatAmount(500, 'g', 'flour')).toBe('500 g flour');
    expect(formatAmount(2, 'tbsp', 'oil')).toBe('2 tbsp oil');
  });

  it('says to taste rather than inventing an amount', () => {
    expect(formatAmount(null, 'to_taste', 'salt')).toBe('salt, to taste');
    expect(formatAmount(null, null, 'salt')).toBe('salt');
  });

  it('trims float noise', () => {
    expect(formatAmount(0.30000000000000004, 'kg', 'paneer')).toBe('0.3 kg paneer');
  });
});

describe('formatQuantity', () => {
  it('gives the amount alone for screens that show the name apart', () => {
    expect(formatQuantity(1, 'kg')).toBe('1 kg');
    expect(formatQuantity(6, 'piece')).toBe('6');
    expect(formatQuantity(2, 'bunch')).toBe('2 bunches');
    expect(formatQuantity(null, 'g')).toBe('');
    expect(formatQuantity(1, 'to_taste')).toBe('');
  });
});
