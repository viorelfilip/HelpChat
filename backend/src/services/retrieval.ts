import type { ChunkSource } from '@practica/shared';
import { config } from '../config.js';
import { pool, toVectorLiteral } from '../db/pool.js';
import { normalizeRelPath } from './paths.js';
import { embed } from './ollama.js';

export interface RetrievedChunk {
  chunkId: number;
  documentId: number;
  relPath: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  text: string;
  source: ChunkSource;
  score: number;
  mediaIds: number[];
}

interface ChunkRow {
  chunk_id: number;
  document_id: number;
  rel_path: string;
  title: string;
  page_start: number;
  page_end: number;
  text: string;
  source: ChunkSource;
  media_ids: number[];
}

const ACTIVE_JOIN = `
  FROM chunks c
  JOIN document_versions v ON v.id = c.version_id AND v.status = 'active'
  JOIN documents d ON d.id = v.document_id AND d.status = 'active'
`;

const SELECT_FIELDS = `
  c.id AS chunk_id, d.id AS document_id, d.rel_path, d.title,
  c.page_start, c.page_end, c.text, c.source, c.media_ids
`;

/**
 * Fuziune Reciprocal Rank Fusion: scor = Σ 1/(k + rang) peste listele în care
 * apare fiecare element. Pură și testabilă independent de DB.
 */
export function rrfFuse<T>(lists: T[][], key: (item: T) => number | string, k = 60): Array<{ item: T; score: number }> {
  const scores = new Map<number | string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = key(item);
      const entry = scores.get(id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

/** Căutare hibridă: semantic (pgvector, cosine) + lexical (tsvector) + RRF. */
export async function hybridSearch(query: string): Promise<RetrievedChunk[]> {
  const [queryVector] = await embed([query]);

  const semantic = pool.query<ChunkRow>(
    `SELECT ${SELECT_FIELDS} ${ACTIVE_JOIN}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(queryVector), config.TOP_K_SEMANTIC]
  );

  const lexical = pool.query<ChunkRow>(
    `SELECT ${SELECT_FIELDS} ${ACTIVE_JOIN}
     WHERE c.tsv @@ websearch_to_tsquery('romanian', immutable_unaccent($1))
     ORDER BY ts_rank(c.tsv, websearch_to_tsquery('romanian', immutable_unaccent($1))) DESC
     LIMIT $2`,
    [query, config.TOP_K_LEXICAL]
  );

  const [semanticRows, lexicalRows] = await Promise.all([semantic, lexical]);

  const fused = rrfFuse([semanticRows.rows, lexicalRows.rows], (r) => r.chunk_id);

  // Normalizăm la citire: citările și antetele fragmentelor arată la fel indiferent
  // de platforma pe care a fost indexat documentul.
  return fused.slice(0, config.TOP_N_CONTEXT).map(({ item, score }) => ({
    chunkId: item.chunk_id,
    documentId: item.document_id,
    relPath: normalizeRelPath(item.rel_path),
    title: item.title,
    pageStart: item.page_start,
    pageEnd: item.page_end,
    text: item.text,
    source: item.source,
    score,
    mediaIds: item.media_ids ?? [],
  }));
}
