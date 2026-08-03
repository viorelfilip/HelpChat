import { describe, expect, it } from 'vitest';
import { isSuspiciousWipe } from './indexer.js';

describe('isSuspiciousWipe', () => {
  it('nimic dispărut → nimic de făcut', () => {
    expect(isSuspiciousWipe(0, 278, 278)).toBe(false);
  });

  it('câteva fișiere șterse de utilizator sunt normale', () => {
    expect(isSuspiciousWipe(3, 278, 275)).toBe(false);
  });

  it('folder gol, dar indexul are documente → configurare greșită', () => {
    expect(isSuspiciousWipe(278, 278, 0)).toBe(true);
  });

  it('dispariția întregului index în timp ce discul are fișiere → blocat', () => {
    // Cazul a două instanțe cu separatori diferiți pe aceeași bază de date.
    expect(isSuspiciousWipe(278, 278, 278)).toBe(true);
  });

  it('sub jumătate din index nu declanșează protecția', () => {
    expect(isSuspiciousWipe(100, 278, 178)).toBe(false);
  });

  it('index mic: ștergerile rămân permise', () => {
    expect(isSuspiciousWipe(4, 5, 1)).toBe(false);
  });
});
