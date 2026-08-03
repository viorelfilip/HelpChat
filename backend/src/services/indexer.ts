import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { config } from '../config.js';
import { pool, withTransaction, toVectorLiteral } from '../db/pool.js';
import { normalizeRelPath, toAbsPath, toRelPath } from './paths.js';
import { logEvent } from './events.js';
import { embed } from './ollama.js';
import { ocrImage } from './ollama.js';
import { openPdf, MIN_TEXT_CHARS_PER_PAGE } from './pdf.js';
import { extractDocxContent, type ExtractedImage } from './docx.js';
import { extractVideoPages } from './video.js';
import { chunkPages, chunkPagesAtomic, type PageText } from './chunker.js';

const EMBED_BATCH_SIZE = 32;

/** Reconcilierea refuză să șteargă mai mult de atât din index într-o singură scanare.
 *  Un val de „fișiere dispărute" care atinge tot indexul nu înseamnă că userul a golit
 *  folderul, ci că `PDF_DIR` e greșit, folderul nu e montat, sau altă instanță scrie
 *  în aceeași bază de date. În toate cazurile, a păstra indexul e alegerea sigură. */
const MAX_DELETE_RATIO = 0.5;
/** Sub acest număr, ștergerile sunt normale (ai șters efectiv câteva fișiere). */
const DELETE_GUARD_MIN = 10;

/** Extensiile indexabile; orice alt fișier din folder este ignorat tăcut. */
export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.mp4'];

export function isSupportedFile(name: string): boolean {
  const lower = name.toLowerCase();
  // ~$foo.docx sunt fișiere temporare de lock create de Word.
  if (lower.startsWith('~$')) return false;
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Decide dacă un val de „fișiere dispărute" e real sau semn de configurare greșită.
 *  Un folder gol sau o dispariție care atinge jumătate din index nu se șterge tăcut. */
export function isSuspiciousWipe(missing: number, tracked: number, foundOnDisk: number): boolean {
  if (missing === 0) return false;
  if (foundOnDisk === 0) return true;
  return missing > DELETE_GUARD_MIN && missing > tracked * MAX_DELETE_RATIO;
}

let lastScanAt: string | null = null;
let running = 0;

/** Coadă serializată: o singură operație de indexare rulează la un moment dat,
 *  ca watcher-ul și reindexarea manuală să nu se calce pe picioare. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export function indexerStatus() {
  return { running: running > 0, lastScanAt };
}

/** Scanează folderul PDF: indexează fișiere noi/modificate, marchează dispărutele.
 *  Cu `force`, reindexează tot, ignorând hash-urile (necesar când se schimbă
 *  modul de procesare, ex. extracția de imagini). */
export function scanAll(force = false): Promise<{ indexed: number; skipped: number; failed: number; deleted: number }> {
  return enqueue(async () => {
    running++;
    try {
      const found = await listSourceFiles(config.pdfDir);
      await logEvent(
        'info',
        'scan',
        `Scanare${force ? ' forțată' : ''}: ${found.length} documente (${SUPPORTED_EXTENSIONS.join(', ')}) în ${config.pdfDir}`
      );
      let indexed = 0,
        skipped = 0,
        failed = 0;

      for (const relPath of found) {
        const result = await indexOne(relPath, force);
        if (result === 'indexed') indexed++;
        else if (result === 'skipped') skipped++;
        else failed++;
      }

      // Documentele din DB care nu mai există pe disc → deleted.
      const { rows } = await pool.query<{ id: number; rel_path: string }>(
        `SELECT id, rel_path FROM documents WHERE status <> 'deleted'`
      );
      const onDisk = new Set(found);
      const missing = rows.filter((r) => !onDisk.has(normalizeRelPath(r.rel_path)));

      let deleted = 0;
      if (isSuspiciousWipe(missing.length, rows.length, found.length)) {
        await logEvent(
          'error',
          'scan',
          `Reconciliere oprită: ${missing.length} din ${rows.length} documente par dispărute de pe disc, ` +
            `dar scanarea a găsit ${found.length} fișiere în ${config.pdfDir}. ` +
            `Verifică PDF_DIR sau dacă altă instanță folosește aceeași bază de date. Indexul rămâne neatins.`
        );
      } else {
        for (const row of missing) {
          await pool.query(`UPDATE documents SET status = 'deleted', updated_at = now() WHERE id = $1`, [row.id]);
          const gone = await pool.query<{ id: number }>(
            `DELETE FROM document_versions WHERE document_id = $1 RETURNING id`,
            [row.id]
          );
          await removeMediaDirs(gone.rows.map((r) => r.id));
          await logEvent('info', 'scan', 'Fișier dispărut de pe disc — marcat ca șters', row.rel_path);
          deleted++;
        }
      }

      lastScanAt = new Date().toISOString();
      await logEvent('info', 'scan', `Scanare încheiată: ${indexed} indexate, ${skipped} neschimbate, ${failed} eșuate, ${deleted} șterse`);
      return { indexed, skipped, failed, deleted };
    } finally {
      running--;
    }
  });
}

/** Indexează un singur fișier (folosit de watcher). */
export function indexFile(relPath: string, force = false): Promise<'indexed' | 'skipped' | 'failed'> {
  return enqueue(async () => {
    running++;
    try {
      return await indexOne(relPath, force);
    } finally {
      running--;
    }
  });
}

/** Marchează un document dispărut (folosit de watcher la unlink). */
export function markDeleted(relPath: string): Promise<void> {
  return enqueue(async () => {
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM documents WHERE rel_path = $1`, [
      normalizeRelPath(relPath),
    ]);
    if (!rows.length) return;
    await pool.query(`UPDATE documents SET status = 'deleted', updated_at = now() WHERE id = $1`, [rows[0].id]);
    const gone = await pool.query<{ id: number }>(
      `DELETE FROM document_versions WHERE document_id = $1 RETURNING id`,
      [rows[0].id]
    );
    await removeMediaDirs(gone.rows.map((r) => r.id));
    await logEvent('info', 'watch', 'Fișier șters — index eliminat', relPath);
  });
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      await logEvent('error', 'scan', `Nu pot citi folderul ${current}: ${(err as Error).message}`);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && isSupportedFile(e.name)) out.push(toRelPath(dir, full));
    }
  }
  await walk(dir);
  return out.sort();
}

interface ExtractedContent {
  pages: PageText[];
  pageCount: number | null;
  ocrPages: number;
  /** Imagini (capturi de ecran) referite în text prin marcaje [IMG:n]. */
  images: ExtractedImage[];
  /** Paginile sunt unități de sine stătătoare (cadre video) și nu se fuzionează. */
  atomicPages?: boolean;
}

/** Extrage marcajele [IMG:n] dintr-un fragment: textul curat + seq-urile imaginilor. */
export function parseMediaMarkers(text: string): { cleanText: string; seqs: number[] } {
  const seqs: number[] = [];
  const cleanText = text
    .replace(/\[IMG:(\d+)\]/g, (_, n) => {
      const seq = Number(n);
      if (!seqs.includes(seq)) seqs.push(seq);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanText, seqs };
}

/** Extrage conținutul în funcție de tipul fișierului. */
async function extractContent(relPath: string, buffer: Buffer): Promise<ExtractedContent> {
  if (relPath.toLowerCase().endsWith('.mp4')) {
    const { pages, images } = await extractVideoPages(toAbsPath(config.pdfDir, relPath), relPath);
    return { pages, pageCount: null, ocrPages: 0, images, atomicPages: true };
  }
  if (relPath.toLowerCase().endsWith('.docx')) {
    const { text, images } = await extractDocxContent(buffer);
    return {
      pages: text ? [{ page: 1, text, source: 'text' }] : [],
      pageCount: null, // .docx nu are paginare fixă
      ocrPages: 0,
      images,
    };
  }

  const pdf = await openPdf(new Uint8Array(buffer));
  try {
    const pages: PageText[] = [];
    let ocrPages = 0;
    for (let p = 1; p <= pdf.pageCount; p++) {
      let text = '';
      try {
        text = await pdf.getPageText(p);
      } catch (err) {
        await logEvent('warn', 'parse', `Pagina ${p}: extragere text eșuată (${(err as Error).message})`, relPath);
      }
      if (text.length >= MIN_TEXT_CHARS_PER_PAGE) {
        pages.push({ page: p, text, source: 'text' });
        continue;
      }
      // Pagină fără strat de text → OCR cu glm-ocr.
      try {
        const png = await pdf.renderPagePng(p);
        const ocrText = (await ocrImage(png.toString('base64'))).trim();
        ocrPages++;
        if (ocrText.length >= MIN_TEXT_CHARS_PER_PAGE) {
          pages.push({ page: p, text: ocrText, source: 'ocr' });
        } else {
          await logEvent('warn', 'ocr', `Pagina ${p}: nici OCR nu a găsit text`, relPath);
        }
      } catch (err) {
        await logEvent('error', 'ocr', `Pagina ${p}: OCR eșuat (${(err as Error).message})`, relPath);
      }
    }
    return { pages, pageCount: pdf.pageCount, ocrPages, images: [] };
  } finally {
    await pdf.destroy();
  }
}

/** Șterge de pe disc folderele cu imagini ale versiunilor eliminate. */
async function removeMediaDirs(versionIds: number[]): Promise<void> {
  for (const id of versionIds) {
    await rm(join(config.mediaDir, String(id)), { recursive: true, force: true }).catch(() => {});
  }
}

async function indexOne(rawRelPath: string, force = false): Promise<'indexed' | 'skipped' | 'failed'> {
  const relPath = normalizeRelPath(rawRelPath);
  const absPath = toAbsPath(config.pdfDir, relPath);
  let buffer: Buffer;
  try {
    buffer = await readFile(absPath);
  } catch (err) {
    await logEvent('error', 'read', `Nu pot citi fișierul: ${(err as Error).message}`, relPath);
    return 'failed';
  }

  const hash = createHash('sha256').update(buffer).digest('hex');

  // Documentul există deja cu același conținut activ? → idempotență, skip.
  const existing = await pool.query<{ doc_id: number; version_id: number | null }>(
    `SELECT d.id AS doc_id, v.id AS version_id
     FROM documents d
     LEFT JOIN document_versions v
       ON v.document_id = d.id AND v.status = 'active' AND v.content_hash = $2
     WHERE d.rel_path = $1`,
    [relPath, hash]
  );
  if (!force && existing.rows.length && existing.rows[0].version_id !== null) {
    // Reactivăm documentul dacă fusese marcat șters dar fișierul a reapărut identic.
    await pool.query(`UPDATE documents SET status = 'active', updated_at = now() WHERE id = $1 AND status <> 'active'`, [
      existing.rows[0].doc_id,
    ]);
    return 'skipped';
  }

  const title = basename(relPath, extname(relPath));
  const docId =
    existing.rows.length > 0
      ? existing.rows[0].doc_id
      : (
          await pool.query<{ id: number }>(
            `INSERT INTO documents (rel_path, title, status) VALUES ($1, $2, 'indexing')
             ON CONFLICT (rel_path) DO UPDATE SET updated_at = now()
             RETURNING id`,
            [relPath, title]
          )
        ).rows[0].id;

  const versionId = (
    await pool.query<{ id: number }>(
      `INSERT INTO document_versions (document_id, content_hash, status) VALUES ($1, $2, 'indexing') RETURNING id`,
      [docId, hash]
    )
  ).rows[0].id;

  await logEvent('info', 'index', `Indexare pornită (hash ${hash.slice(0, 12)}…)`, relPath);

  try {
    const { pages, pageCount, ocrPages, images, atomicPages } = await extractContent(relPath, buffer);

    // Cadrele video sunt descrieri complete în sine: fuzionarea lor ar amesteca
    // două ecrane într-un fragment și ar transforma citarea într-un interval.
    const rawChunks = atomicPages
      ? chunkPagesAtomic(pages)
      : chunkPages(pages, config.CHUNK_SIZE, config.CHUNK_OVERLAP);
    // Scoatem marcajele [IMG:n] din text și reținem ce imagini aparțin fiecărui fragment.
    const chunks = rawChunks
      .map((c) => {
        const { cleanText, seqs } = parseMediaMarkers(c.text);
        return { ...c, text: cleanText, imageSeqs: seqs };
      })
      .filter((c) => c.text.length > 0);
    if (chunks.length === 0) {
      throw new Error('Documentul nu conține text indexabil (nici nativ, nici prin OCR)');
    }
    if (ocrPages > 0) {
      await logEvent('info', 'ocr', `${ocrPages} pagini procesate prin OCR`, relPath);
    }

    // Salvăm imaginile pe disc și în tabela media; seq → id.
    const mediaIdBySeq = new Map<number, number>();
    if (images.length > 0) {
      const dir = join(config.mediaDir, String(versionId));
      await mkdir(dir, { recursive: true });
      for (const img of images) {
        const ext = img.mime.includes('png') ? 'png' : img.mime.includes('gif') ? 'gif' : 'jpg';
        const filePath = `${versionId}/${img.seq}.${ext}`;
        await writeFile(join(config.mediaDir, filePath), img.buffer);
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO media (version_id, seq, file_path, mime) VALUES ($1, $2, $3, $4) RETURNING id`,
          [versionId, img.seq, filePath, img.mime]
        );
        mediaIdBySeq.set(img.seq, rows[0].id);
      }
    }

    // Embeddings în loturi (pe textul curat, fără marcaje).
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      vectors.push(...(await embed(batch.map((c) => c.text))));
    }

    // Inserăm chunks, apoi comutăm atomic versiunea activă.
    const replacedVersionIds: number[] = [];
    await withTransaction(async (client) => {
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const mediaIds = c.imageSeqs.map((s) => mediaIdBySeq.get(s)).filter((x): x is number => x !== undefined);
        await client.query(
          `INSERT INTO chunks (version_id, chunk_index, page_start, page_end, source, text, embedding, media_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
          [versionId, c.index, c.pageStart, c.pageEnd, c.source, c.text, toVectorLiteral(vectors[i]), mediaIds]
        );
      }
      await client.query(
        `UPDATE document_versions SET status = 'active', page_count = $2, indexed_at = now() WHERE id = $1`,
        [versionId, pageCount]
      );
      const gone = await client.query<{ id: number }>(
        `DELETE FROM document_versions WHERE document_id = $1 AND id <> $2 RETURNING id`,
        [docId, versionId]
      );
      replacedVersionIds.push(...gone.rows.map((r) => r.id));
      await client.query(`UPDATE documents SET status = 'active', title = $2, updated_at = now() WHERE id = $1`, [
        docId,
        title,
      ]);
    });
    await removeMediaDirs(replacedVersionIds);

    await logEvent(
      'info',
      'index',
      `Indexat: ${pageCount === null ? 'fără paginare' : `${pageCount} pagini`}, ${chunks.length} fragmente` +
        (images.length ? `, ${images.length} imagini` : ''),
      relPath
    );
    return 'indexed';
  } catch (err) {
    await pool.query(`UPDATE document_versions SET status = 'failed', error = $2 WHERE id = $1`, [
      versionId,
      (err as Error).message,
    ]);
    // Dacă documentul nu are nicio versiune activă, îl marcăm failed; altfel rămâne activă versiunea veche.
    await pool.query(
      `UPDATE documents SET
         status = CASE WHEN EXISTS (SELECT 1 FROM document_versions WHERE document_id = $1 AND status = 'active')
                       THEN 'active' ELSE 'failed' END,
         updated_at = now()
       WHERE id = $1`,
      [docId]
    );
    await logEvent('error', 'index', `Indexare eșuată: ${(err as Error).message}`, relPath);
    return 'failed';
  }
}
