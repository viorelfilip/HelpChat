import { describe, expect, it } from 'vitest';
import { formatTimestamp, pickEvenly, stripWordCount } from './video.js';

describe('stripWordCount', () => {
  it('scoate numărătoarea de cuvinte de la finalul descrierii', () => {
    expect(stripWordCount('Ecranul afișează modulul "Buget". (148 cuvinte)')).toBe(
      'Ecranul afișează modulul "Buget".'
    );
  });

  it('acceptă variantele cu aproximare', () => {
    expect(stripWordCount('Text. (aproximativ 150 cuvinte)')).toBe('Text.');
    expect(stripWordCount('Text. (~150 cuvinte)')).toBe('Text.');
  });

  it('nu atinge o descriere care nu se termină așa', () => {
    const text = 'Butonul "Salvare" apare lângă câmpul cu 148 de caractere.';
    expect(stripWordCount(text)).toBe(text);
  });

  it('nu taie paranteze din mijlocul textului', () => {
    const text = 'Ecranul (v7.3.1-beta) afișează 12 cuvinte cheie în antet.';
    expect(stripWordCount(text)).toBe(text);
  });
});

describe('formatTimestamp', () => {
  it('formatează secundele ca m:ss', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(8.67)).toBe('0:08');
    expect(formatTimestamp(155)).toBe('2:35');
    expect(formatTimestamp(3671)).toBe('61:11');
  });
});

describe('pickEvenly', () => {
  it('sub limită returnează tot', () => {
    expect(pickEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('păstrează primul și ultimul element și respectă limita', () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const picked = pickEvenly(items, 12);
    expect(picked.length).toBeLessThanOrEqual(12);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(39);
  });

  it('elementele alese sunt strict crescătoare (fără duplicate)', () => {
    const picked = pickEvenly([10, 20, 30, 40, 50], 3);
    expect(picked).toEqual([10, 30, 50]);
  });
});
