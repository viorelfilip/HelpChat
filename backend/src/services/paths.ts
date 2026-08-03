import { join, relative } from 'node:path';

/**
 * Identitatea unui document în baza de date este calea lui relativă la `PDF_DIR`,
 * scrisă mereu cu separatori POSIX.
 *
 * Fără normalizare, aceeași ierarhie de fișiere produce `a/b.docx` pe Unix și
 * `a\b.docx` pe Windows. Cele două forme nu se potrivesc niciodată, așa că
 * reconcilierea de la scanare crede că fișierele celeilalte platforme au dispărut
 * de pe disc și le marchează șterse — cu tot cu fragmentele lor.
 */

/** Aduce la forma canonică o cale venită din orice sursă: disc, watcher sau bază. */
export function normalizeRelPath(relPath: string): string {
  return relPath.split(/[\\/]+/).join('/');
}

/** Calea canonică a unui fișier de pe disc, relativă la `dir`. */
export function toRelPath(dir: string, absPath: string): string {
  return normalizeRelPath(relative(dir, absPath));
}

/** Calea absolută locală a unui document, indiferent de separatorii cu care a fost salvat. */
export function toAbsPath(dir: string, relPath: string): string {
  return join(dir, ...normalizeRelPath(relPath).split('/'));
}

/** Folderul care conține documentul; '' pentru fișierele din rădăcina `PDF_DIR`. */
export function folderOf(relPath: string): string {
  const canon = normalizeRelPath(relPath);
  const cut = canon.lastIndexOf('/');
  return cut === -1 ? '' : canon.slice(0, cut);
}
