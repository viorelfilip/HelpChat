import { describe, expect, it } from 'vitest';
import { sep } from 'node:path';
import { folderOf, normalizeRelPath, toAbsPath, toRelPath } from './paths.js';

describe('normalizeRelPath', () => {
  it('transformă separatorii Windows în POSIX', () => {
    expect(normalizeRelPath('MANUAL\\ACHIZITII\\Referat.docx')).toBe('MANUAL/ACHIZITII/Referat.docx');
  });

  it('lasă neatinsă o cale deja canonică', () => {
    expect(normalizeRelPath('MANUAL/ACHIZITII/Referat.docx')).toBe('MANUAL/ACHIZITII/Referat.docx');
  });

  it('este idempotentă și tratează formele mixte', () => {
    const mixed = 'MANUAL\\ACHIZITII/Referat.docx';
    expect(normalizeRelPath(mixed)).toBe('MANUAL/ACHIZITII/Referat.docx');
    expect(normalizeRelPath(normalizeRelPath(mixed))).toBe(normalizeRelPath(mixed));
  });

  it('colapsează separatorii repetați', () => {
    expect(normalizeRelPath('MANUAL\\\\ACHIZITII//Referat.docx')).toBe('MANUAL/ACHIZITII/Referat.docx');
  });

  it('păstrează spațiile și diacriticele din nume', () => {
    expect(normalizeRelPath('MANUAL UTILIZARE\\Manual Achiziții.docx')).toBe('MANUAL UTILIZARE/Manual Achiziții.docx');
  });
});

describe('toRelPath', () => {
  it('produce aceeași cale indiferent de platformă', () => {
    const dir = `${sep}date${sep}documents`;
    const abs = `${dir}${sep}MANUAL${sep}Referat.docx`;
    expect(toRelPath(dir, abs)).toBe('MANUAL/Referat.docx');
  });
});

describe('toAbsPath', () => {
  it('reconstruiește calea locală dintr-o cale salvată cu backslash', () => {
    const dir = `${sep}date${sep}documents`;
    expect(toAbsPath(dir, 'MANUAL\\Referat.docx')).toBe(`${dir}${sep}MANUAL${sep}Referat.docx`);
  });

  it('reconstruiește calea locală dintr-o cale salvată cu slash', () => {
    const dir = `${sep}date${sep}documents`;
    expect(toAbsPath(dir, 'MANUAL/Referat.docx')).toBe(`${dir}${sep}MANUAL${sep}Referat.docx`);
  });

  it('dus-întors: o cale de pe disc se regăsește identic', () => {
    const dir = `${sep}date${sep}documents`;
    const abs = `${dir}${sep}A${sep}B${sep}c.docx`;
    expect(toAbsPath(dir, toRelPath(dir, abs))).toBe(abs);
  });
});

describe('folderOf', () => {
  it('extrage folderul din ambele forme', () => {
    expect(folderOf('MANUAL\\ACHIZITII\\Referat.docx')).toBe('MANUAL/ACHIZITII');
    expect(folderOf('MANUAL/ACHIZITII/Referat.docx')).toBe('MANUAL/ACHIZITII');
  });

  it('întoarce gol pentru fișierele din rădăcină', () => {
    expect(folderOf('Referat.docx')).toBe('');
  });
});
