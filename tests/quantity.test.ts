import { describe, expect, it } from 'vitest';
import { convert, formatAmount, parseIngredient, parseUnitSize } from '../src/planning/quantity.js';

describe('parseIngredient', () => {
  it('reads Dutch quantities and units', () => {
    const p = parseIngredient('500 g kipfilet, in blokjes');
    expect(p.amount).toEqual({ value: 500, dimension: 'mass' });
    expect(p.name).toBe('kipfilet');
    expect(p.note).toBe('in blokjes');
    expect(p.pantry).toBe(false);
  });

  it('turns spoons into millilitres and marks pantry items', () => {
    const p = parseIngredient('2 el olijfolie');
    expect(p.amount).toEqual({ value: 30, dimension: 'volume' });
    expect(p.name).toBe('olijfolie');
    expect(p.pantry).toBe(true);
  });

  it('handles fractions, mixed numbers and unicode fractions', () => {
    expect(parseIngredient('1/2 tl komijn').amount?.value).toBeCloseTo(2.5);
    expect(parseIngredient('1 1/2 cups rice').amount?.value).toBeCloseTo(360);
    expect(parseIngredient('1½ kg aardappelen').amount).toEqual({ value: 1500, dimension: 'mass' });
    expect(parseIngredient('½ komkommer').amount).toEqual({ value: 0.5, dimension: 'count' });
  });

  it('resolves ranges to the upper bound', () => {
    expect(parseIngredient('2-3 tenen knoflook').amount).toEqual({ value: 3, dimension: 'count' });
    expect(parseIngredient('200 tot 250 g spinazie').amount).toEqual({ value: 250, dimension: 'mass' });
  });

  it('splits glued units and parenthetical notes', () => {
    const p = parseIngredient('400g tomaten (blik)');
    expect(p.amount).toEqual({ value: 400, dimension: 'mass' });
    expect(p.name).toBe('tomaten');
    expect(p.note).toBe('blik');
  });

  it('counts pieces without a unit', () => {
    const p = parseIngredient('2 uien');
    expect(p.amount).toEqual({ value: 2, dimension: 'count' });
    expect(p.name).toBe('uien');
  });

  it('keeps lines without a quantity as a name', () => {
    const p = parseIngredient('zout en peper');
    expect(p.amount).toBeUndefined();
    expect(p.pantry).toBe(true);
  });

  it('reads English imperial units', () => {
    expect(parseIngredient('8 oz cheddar').amount?.value).toBeCloseTo(226.8);
    expect(parseIngredient('1 lb ground beef').amount?.value).toBeCloseTo(453.6);
  });
});

describe('parseUnitSize', () => {
  it('reads AH style unit sizes', () => {
    expect(parseUnitSize('500 g')).toEqual({ value: 500, dimension: 'mass' });
    expect(parseUnitSize('1,5 l')).toEqual({ value: 1500, dimension: 'volume' });
    expect(parseUnitSize('6 stuks')).toEqual({ value: 6, dimension: 'count' });
    expect(parseUnitSize('4 x 125 g')).toEqual({ value: 500, dimension: 'mass' });
    expect(parseUnitSize('ca. 450 g')).toEqual({ value: 450, dimension: 'mass' });
    expect(parseUnitSize('per stuk')).toEqual({ value: 1, dimension: 'count' });
    expect(parseUnitSize('1 kilo')).toEqual({ value: 1000, dimension: 'mass' });
    expect(parseUnitSize('')).toBeUndefined();
  });
});

describe('convert', () => {
  it('bridges pieces and grams with typical weights', () => {
    expect(convert({ value: 2, dimension: 'count' }, 'mass', 'uien')).toEqual({
      value: 240,
      estimated: true,
    });
    expect(convert({ value: 300, dimension: 'mass' }, 'mass', 'x')).toEqual({ value: 300, estimated: false });
    expect(convert({ value: 2, dimension: 'count' }, 'mass', 'unknown thing')).toBeUndefined();
  });

  it('formats amounts for people', () => {
    expect(formatAmount({ value: 1500, dimension: 'mass' })).toBe('1.5 kg');
    expect(formatAmount({ value: 30, dimension: 'volume' })).toBe('30 ml');
    expect(formatAmount({ value: 3, dimension: 'count' })).toBe('3 st');
  });
});
