import chokidar from 'chokidar';
import { config } from '../config.js';
import { indexFile, isSupportedFile, markDeleted, scanAll } from './indexer.js';
import { toRelPath } from './paths.js';
import { logEvent } from './events.js';
import { basename } from 'node:path';

/** Scanare completă la pornire + monitorizare continuă a folderului PDF. */
export function startWatcher(): void {
  scanAll().catch((err) => logEvent('error', 'scan', `Scanarea inițială a eșuat: ${err.message}`));

  const watcher = chokidar.watch(config.pdfDir, {
    ignoreInitial: true,
    // Așteaptă ca fișierul să fie scris complet (copieri mari) înainte de indexare.
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });

  const supported = (path: string) => isSupportedFile(basename(path));
  const rel = (path: string) => toRelPath(config.pdfDir, path);

  watcher
    .on('add', (path) => {
      if (supported(path)) void indexFile(rel(path));
    })
    .on('change', (path) => {
      if (supported(path)) void indexFile(rel(path));
    })
    .on('unlink', (path) => {
      if (supported(path)) void markDeleted(rel(path));
    })
    .on('error', (err) => void logEvent('error', 'watch', (err as Error).message));

  console.log(`Monitorizez folderul: ${config.pdfDir}`);
}
