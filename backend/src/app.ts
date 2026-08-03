import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChatStreamEvent, DocumentSummary, IndexStatus, StarterSuggestions } from '@practica/shared';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { healthCheck } from './services/health.js';
import { answerQuestion } from './services/chat.js';
import { indexerStatus, scanAll } from './services/indexer.js';
import { getStarterSuggestions } from './services/suggestions.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // În producție (Docker) servim build-ul frontend-ului dacă există.
  const frontendDist = resolve(config.projectRoot, 'frontend/dist');
  if (existsSync(frontendDist)) {
    await app.register(fastifyStatic, { root: frontendDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'Ruta nu există' });
      return reply.sendFile('index.html');
    });
  }

  app.get('/api/health', async () => healthCheck());

  // === Documente / admin ===

  app.get('/api/documents', async (): Promise<DocumentSummary[]> => {
    const { rows } = await pool.query(
      `SELECT d.id, d.rel_path, d.title, d.status, d.updated_at,
              v.page_count, v.indexed_at, v.error,
              COALESCE(c.total, 0)::int AS chunk_count,
              COALESCE(c.ocr, 0)::int AS ocr_chunk_count
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT * FROM document_versions
         WHERE document_id = d.id
         ORDER BY (status = 'active') DESC, id DESC LIMIT 1
       ) v ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS total, count(*) FILTER (WHERE source = 'ocr') AS ocr
         FROM chunks WHERE version_id = v.id
       ) c ON true
       ORDER BY d.rel_path`
    );
    return rows.map((r) => ({
      id: r.id,
      relPath: r.rel_path,
      title: r.title,
      status: r.status,
      pageCount: r.page_count,
      chunkCount: r.chunk_count,
      ocrChunkCount: r.ocr_chunk_count,
      indexedAt: r.indexed_at,
      error: r.error,
      updatedAt: r.updated_at,
    }));
  });

  app.get('/api/admin/status', async (): Promise<IndexStatus> => {
    const { rows } = await pool.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM documents GROUP BY status`
    );
    const counts = { active: 0, indexing: 0, failed: 0, deleted: 0 };
    for (const r of rows) counts[r.status as keyof typeof counts] = Number(r.n);
    const chunks = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM chunks c JOIN document_versions v ON v.id = c.version_id AND v.status = 'active'`
    );
    return { ...indexerStatus(), documents: counts, chunks: Number(chunks.rows[0].n) };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/admin/events', async (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT id, level, stage, rel_path, message, created_at
       FROM ingestion_events ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      stage: r.stage,
      relPath: r.rel_path,
      message: r.message,
      createdAt: r.created_at,
    }));
  });

  app.post<{ Body: { force?: boolean } }>('/api/admin/reindex', async (req) => {
    const force = req.body?.force === true;
    void scanAll(force);
    return { started: true, force };
  });

  // Servește imaginile extrase din documente (capturi de ecran, cadre video).
  app.get<{ Params: { id: string } }>('/api/media/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Id invalid' });
    const { rows } = await pool.query<{ file_path: string; mime: string }>(
      `SELECT file_path, mime FROM media WHERE id = $1`,
      [id]
    );
    if (!rows.length) return reply.code(404).send({ error: 'Imaginea nu există' });
    try {
      const data = await readFile(resolve(config.mediaDir, rows[0].file_path));
      return reply.type(rows[0].mime).header('Cache-Control', 'public, max-age=86400').send(data);
    } catch {
      return reply.code(404).send({ error: 'Fișierul imaginii lipsește de pe disc' });
    }
  });

  // Sugestii de pornire pentru o conversație nouă (teme indexate + facturi).
  app.get('/api/suggestions', async (): Promise<StarterSuggestions> => getStarterSuggestions());

  // === Conversații ===

  app.get('/api/conversations', async () => {
    const { rows } = await pool.query(
      `SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC`
    );
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT id, conversation_id, role, content, citations, suggestions, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [req.params.id]
    );
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      citations: r.citations,
      suggestions: r.suggestions,
      createdAt: r.created_at,
    }));
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req) => {
    await pool.query(`DELETE FROM conversations WHERE id = $1`, [req.params.id]);
    return { deleted: true };
  });

  // === Chat (SSE) ===

  app.post<{ Body: { conversationId?: number; question?: string } }>('/api/chat', async (req, reply) => {
    const question = req.body?.question?.trim();
    if (!question) {
      return reply.code(400).send({ error: 'Lipsește întrebarea' });
    }

    let conversationId = req.body?.conversationId;
    if (!conversationId) {
      const title = question.length > 80 ? `${question.slice(0, 77)}…` : question;
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO conversations (title) VALUES ($1) RETURNING id`,
        [title]
      );
      conversationId = rows[0].id;
    } else {
      const { rows } = await pool.query(`SELECT 1 FROM conversations WHERE id = $1`, [conversationId]);
      if (!rows.length) return reply.code(404).send({ error: 'Conversația nu există' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event: ChatStreamEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ type: 'conversation', conversationId });

    try {
      for await (const event of answerQuestion(conversationId, question)) {
        send(event);
      }
    } catch (err) {
      send({ type: 'error', message: (err as Error).message });
    }

    reply.raw.end();
    return reply;
  });

  return app;
}
