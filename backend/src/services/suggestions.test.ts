import { describe, expect, it } from 'vitest';
import { parseFollowUps } from './suggestions.js';

describe('parseFollowUps', () => {
  it('extrage întrebările simple, câte una pe linie', () => {
    expect(parseFollowUps('Cum adaug un OP?\nCe rapoarte am la dispoziție?')).toEqual([
      'Cum adaug un OP?',
      'Ce rapoarte am la dispoziție?',
    ]);
  });

  it('elimină numerotarea, bullet-urile și ghilimelele', () => {
    const raw = `1. Cum configurez modulul?
- Ce drepturi are utilizatorul?
* "Unde găsesc jurnalul?"
2) „Cum export raportul?”`;
    expect(parseFollowUps(raw)).toEqual([
      'Cum configurez modulul?',
      'Ce drepturi are utilizatorul?',
      'Unde găsesc jurnalul?',
    ]);
  });

  it('ignoră liniile care nu sunt întrebări (antete, explicații)', () => {
    const raw = `Iată câteva sugestii:

Cum adaug o factură nouă?
Acestea sunt întrebările propuse.`;
    expect(parseFollowUps(raw)).toEqual(['Cum adaug o factură nouă?']);
  });

  it('elimină duplicatele indiferent de majuscule', () => {
    expect(parseFollowUps('Cum adaug un OP?\ncum adaug un OP?\nCe este balanța?')).toEqual([
      'Cum adaug un OP?',
      'Ce este balanța?',
    ]);
  });

  it('limitează la 3 sugestii', () => {
    const raw = ['Prima întrebare?', 'A doua întrebare?', 'A treia întrebare?', 'A patra întrebare?'].join('\n');
    expect(parseFollowUps(raw)).toHaveLength(3);
  });

  it('respinge întrebările prea scurte sau prea lungi', () => {
    const long = `${'Cum '.repeat(40)}?`;
    expect(parseFollowUps(`Ce?\n${long}\nCum adaug un partener nou?`)).toEqual(['Cum adaug un partener nou?']);
  });

  it('răspuns gol sau fără întrebări → listă goală', () => {
    expect(parseFollowUps('')).toEqual([]);
    expect(parseFollowUps('Nu am sugestii de propus.')).toEqual([]);
  });
});
