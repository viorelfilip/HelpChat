import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { describeFrame } from './ollama.js';
import { logEvent } from './events.js';
import type { PageText } from './chunker.js';
import type { ExtractedImage } from './docx.js';

const run = promisify(execFile);

/** Formatează secunde ca m:ss (ex. 155 → "2:35"). */
export function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Modelul vision își raportează adesea bugetul la final — „(148 cuvinte)". E zgomot
 *  care ajunge altfel în embedding, așa că îl scoatem înainte de indexare. */
export function stripWordCount(text: string): string {
  return text.replace(/\s*\(\s*(?:aproximativ\s+|cca\.?\s+|~\s*)?\d+\s*cuvinte\s*\)\s*$/i, '').trimEnd();
}

/** Alege cel mult `max` elemente distribuite uniform, păstrând primul și ultimul. */
export function pickEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const picked: T[] = [];
  for (let i = 0; i < max; i++) {
    picked.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  }
  return [...new Set(picked)];
}

/**
 * Extrage cadrele-cheie dintr-un video (primul cadru + schimbările de scenă),
 * le descrie cu modelul vision și le întoarce ca "pagini" în care numărul
 * paginii este secunda din video — citările devin fișier + minutul sursă.
 *
 * Necesită `ffmpeg` în PATH.
 */
export async function extractVideoPages(
  absPath: string,
  relPath: string
): Promise<{ pages: PageText[]; images: ExtractedImage[] }> {
  const workDir = await mkdtemp(join(tmpdir(), 'rag-video-'));
  try {
    // Un singur pas: selectează cadrele, scalează la 1280px, scrie JPEG-uri;
    // timestamp-urile ies din filtrul showinfo (pe stderr).
    const { stderr } = await run('ffmpeg', [
      '-i', absPath,
      '-vf', `select='eq(n,0)+gt(scene,${config.VIDEO_SCENE_THRESHOLD})',showinfo,scale=1280:-2`,
      '-fps_mode', 'vfr',
      '-q:v', '3',
      join(workDir, 'f_%04d.jpg'),
    ], { maxBuffer: 64 * 1024 * 1024 });

    const timestamps = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]));
    const files = (await readdir(workDir)).filter((f) => f.endsWith('.jpg')).sort();

    let frames = files.map((file, i) => ({ file, ts: timestamps[i] ?? 0 }));
    const detectate = frames.length;
    if (detectate > config.VIDEO_MAX_FRAMES) {
      frames = pickEvenly(frames, config.VIDEO_MAX_FRAMES);
    }
    await logEvent(
      'info',
      'video',
      detectate > frames.length
        ? `${detectate} cadre detectate — descriu ${frames.length}, distribuite uniform`
        : `${detectate} cadre detectate — le descriu pe toate`,
      relPath
    );

    const pages: PageText[] = [];
    const images: ExtractedImage[] = [];
    // Descrierea unui cadru poate dura peste un minut, iar în bază nu se scrie
    // nimic până la finalul documentului — jurnalul e singurul semn de progres.
    for (const [i, frame] of frames.entries()) {
      const pozitie = `Cadrul ${i + 1}/${frames.length} (min. ${formatTimestamp(frame.ts)})`;
      const image = await readFile(join(workDir, frame.file));
      const pornit = Date.now();
      const secunde = () => Math.round((Date.now() - pornit) / 1000);
      try {
        const description = stripWordCount((await describeFrame(image.toString('base64'))).trim());
        if (!description) {
          await logEvent('warn', 'video', `${pozitie}: modelul a returnat descriere goală (${secunde()}s)`, relPath);
        } else {
          const seq = images.length;
          images.push({ seq, buffer: image, mime: 'image/jpeg' });
          pages.push({
            page: Math.max(0, Math.floor(frame.ts)),
            text: `[Cadru la min. ${formatTimestamp(frame.ts)}]\n${description}\n[IMG:${seq}]`,
            source: 'video',
          });
          await logEvent('info', 'video', `${pozitie}: descris în ${secunde()}s, ${description.length} caractere`, relPath);
        }
      } catch (err) {
        await logEvent(
          'warn',
          'video',
          `${pozitie}: descriere eșuată după ${secunde()}s (${(err as Error).message})`,
          relPath
        );
      }
    }
    return { pages, images };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
