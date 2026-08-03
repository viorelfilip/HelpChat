/**
 * Sugestii de discuție: temele disponibile (deduse din documentele indexate),
 * întrebările propuse la deschiderea unei conversații noi și continuările
 * propuse după fiecare răspuns.
 *
 * Sugestiile de start sunt derivate din date reale (module indexate, existența
 * facturilor) — nu propunem subiecte despre care aplicația nu are ce răspunde.
 */
import { pool } from '../db/pool.js';
import { chat } from './ollama.js';

const MODULES_TTL_MS = 5 * 60 * 1000;
const MAX_MODULES = 12;
const MAX_FOLLOWUPS = 3;
const MAX_FOLLOWUP_CHARS = 120;
/** Din răspuns îi dăm modelului doar începutul — e suficient pentru continuări. */
const ANSWER_EXCERPT_CHARS = 1500;

let modulesCache: { at: number; value: string[] } | null = null;

/**
 * Modulele/temele acoperite de documentele indexate, deduse din structura de
 * foldere. Dacă totul stă sub un singur folder rădăcină (ex. "MANUAL UTILIZARE
 * SIGMA"), coborâm un nivel — acolo sunt modulele reale.
 */
export async function getModules(): Promise<string[]> {
  if (modulesCache && Date.now() - modulesCache.at < MODULES_TTL_MS) return modulesCache.value;

  const { rows } = await pool.query<{ folder: string; docs: number }>(
    `WITH level1 AS (
       SELECT NULLIF(split_part(rel_path, '/', 1), '') AS folder, rel_path
       FROM documents WHERE status = 'active' AND position('/' in rel_path) > 0
     ),
     pick AS (
       SELECT CASE WHEN (SELECT count(DISTINCT folder) FROM level1) = 1
                   THEN NULLIF(split_part(rel_path, '/', 2), '')
                   ELSE folder END AS folder
       FROM level1
     )
     SELECT folder, count(*)::int AS docs
     FROM pick WHERE folder IS NOT NULL
     GROUP BY folder ORDER BY docs DESC, folder LIMIT $1`,
    [MAX_MODULES]
  );

  const value = rows.map((r) => r.folder);
  modulesCache = { at: Date.now(), value };
  return value;
}

/** Invalidează cache-ul (după reindexare, când apar module noi). */
export function resetModulesCache(): void {
  modulesCache = null;
}

/** Enumerare pentru prompt: „A, B și C". */
function listRo(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} și ${items[items.length - 1]}`;
}

/**
 * Inventarul de teme trimis modelului, ca să poată propune subiecte concrete
 * când întrebarea e prea vagă. Gol dacă nu există documente indexate.
 */
export async function buildTopicInventory(): Promise<string> {
  const modules = await getModules();
  if (modules.length === 0) return '';
  return `Module acoperite de documentația indexată: ${listRo(modules)}.`;
}

export interface StarterSuggestions {
  /** Temele disponibile, pentru afișare în interfață. */
  topics: string[];
  /** Întrebări gata de trimis. */
  questions: string[];
}

const FACTURI_QUESTIONS = [
  'Ce facturi am de plătit?',
  'Ce facturi am de încasat?',
  'Care este balanța dintre venituri și cheltuieli pe ultima lună?',
];

/**
 * Întrebările propuse la deschiderea unui chat nou: câteva pe documentele
 * indexate (module reale) și câteva pe facturi — acestea din urmă doar dacă
 * există deja date în schema `facturi`.
 */
export async function getStarterSuggestions(): Promise<StarterSuggestions> {
  const [modules, hasInvoices] = await Promise.all([
    getModules(),
    pool
      .query<{ n: number }>(`SELECT count(*)::int AS n FROM facturi.invoices`)
      .then((r) => r.rows[0].n > 0)
      .catch(() => false), // schema facturi lipsește (bază veche) — ignorăm
  ]);

  const questions = modules.slice(0, 3).map((m) => `Ce pot face în modulul ${m}?`);
  if (hasInvoices) questions.push(...FACTURI_QUESTIONS.slice(0, questions.length ? 2 : 3));

  return { topics: modules, questions };
}

/**
 * Curăță lista de continuări întoarsă de model: elimină numerotarea, ghilimelele
 * și liniile care nu sunt întrebări, taie lungimile și duplicatele.
 */
export function parseFollowUps(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of raw.split('\n')) {
    const cleaned = line
      .trim()
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^["'„”]|["'„”]$/g, '')
      .trim();

    // Păstrăm doar întrebări plauzibile: nu antete („Sugestii:"), nu fraze lungi.
    if (!cleaned.endsWith('?') || cleaned.length < 8 || cleaned.length > MAX_FOLLOWUP_CHARS) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length === MAX_FOLLOWUPS) break;
  }
  return out;
}

const FOLLOWUP_PROMPT = `Ești un asistent care propune continuări naturale ale unei discuții.
Pe baza întrebării și a răspunsului de mai jos, formulează maximum ${MAX_FOLLOWUPS} întrebări scurte pe care utilizatorul le-ar putea pune în continuare.

Reguli:
- Fiecare întrebare pe o linie separată, fără numerotare, fără alt text.
- Întrebări scurte (sub 15 cuvinte), în română, formulate din perspectiva utilizatorului.
- Rămâi în aria subiectului discutat sau a temelor înrudite din listă.
- Nu repeta întrebarea deja pusă.
- Dacă răspunsul a fost un refuz (informația lipsește), propune teme apropiate din lista de module.`;

/**
 * Generează continuările discuției printr-un apel scurt, separat, la model.
 * Eșecurile nu propagă: fără sugestii, răspunsul rămâne valid.
 */
export async function generateFollowUps(question: string, answer: string, topicInventory: string): Promise<string[]> {
  if (!answer.trim()) return [];
  try {
    const excerpt = answer.length > ANSWER_EXCERPT_CHARS ? `${answer.slice(0, ANSWER_EXCERPT_CHARS)}…` : answer;
    const raw = await chat([
      { role: 'system', content: FOLLOWUP_PROMPT },
      {
        role: 'user',
        content: [topicInventory, `Întrebarea utilizatorului: ${question}`, `Răspunsul asistentului: ${excerpt}`]
          .filter(Boolean)
          .join('\n\n'),
      },
    ]);
    return parseFollowUps(raw);
  } catch (err) {
    console.error('Nu am putut genera sugestii de continuare:', (err as Error).message);
    return [];
  }
}
