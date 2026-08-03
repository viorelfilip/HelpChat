import { config as loadEnv } from 'dotenv';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnv({ path: resolve(projectRoot, '.env') });

const schema = z.object({
  DATABASE_URL: z.string().url(),
  OLLAMA_URL_CHAT: z.string().url(),
  OLLAMA_URL_EMBED: z.string().url(),
  OLLAMA_URL_OCR: z.string().url(),
  CHAT_MODEL: z.string().min(1),
  CHAT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  EMBED_MODEL: z.string().min(1),
  EMBED_DIM: z.coerce.number().int().positive(),
  OCR_MODEL: z.string().min(1),
  OLLAMA_URL_VISION: z.string().url().default('http://192.168.100.55:11434'),
  VISION_MODEL: z.string().min(1).default('qwen3-vl:32b'),
  VIDEO_MAX_FRAMES: z.coerce.number().int().min(1).default(12),
  VIDEO_SCENE_THRESHOLD: z.coerce.number().min(0.01).max(1).default(0.08),
  PDF_DIR: z.string().min(1),
  MEDIA_DIR: z.string().min(1).default('./media'),
  CHUNK_SIZE: z.coerce.number().int().min(100).default(1000),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).default(150),
  TOP_K_SEMANTIC: z.coerce.number().int().min(1).default(20),
  TOP_K_LEXICAL: z.coerce.number().int().min(1).default(20),
  TOP_N_CONTEXT: z.coerce.number().int().min(1).default(8),
  PORT: z.coerce.number().int().default(3001),
  RESCAN_INTERVAL_MIN: z.coerce.number().int().min(1).default(30),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().default(300_000),
  OLLAMA_KEEP_ALIVE: z.string().default('30m'),
  // Sugestiile de continuare cer un apel scurt suplimentar la model după
  // fiecare răspuns; pot fi oprite dacă latența contează mai mult.
  SUGGESTIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Configurație invalidă (.env):\n${issues}\nCopiază .env.example ca .env și completează valorile.`);
}

const env = parsed.data;

export const config = {
  ...env,
  projectRoot,
  pdfDir: isAbsolute(env.PDF_DIR) ? env.PDF_DIR : resolve(projectRoot, env.PDF_DIR),
  mediaDir: isAbsolute(env.MEDIA_DIR) ? env.MEDIA_DIR : resolve(projectRoot, env.MEDIA_DIR),
};

export type Config = typeof config;
