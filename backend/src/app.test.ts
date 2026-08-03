import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Izolăm testele de rețea: embeddings/chat vin din mock, DB-ul e cel real.
// chatStream emite delte { content?, toolCalls? } — contractul din ollama.ts.
vi.mock('./services/ollama.js', () => ({
  embed: vi.fn(async (input: string[]) => input.map(() => Array(1024).fill(0.01))),
  chat: vi.fn(async () => 'Răspuns de test [S1].'),
  chatStream: vi.fn(async function* () {
    yield { content: 'Răspuns ' };
    yield { content: 'de test [S1].' };
  }),
  ocrImage: vi.fn(async () => ''),
  checkOllama: vi.fn(async () => ({ ok: true, problems: [] })),
}));

const { buildServer } = await import('./app.js');
const { pool } = await import('./db/pool.js');
const { chatStream } = await import('./services/ollama.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('API', () => {
  it('GET /api/documents răspunde cu lista documentelor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('POST /api/chat fără întrebare → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/chat cu conversație inexistentă → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { question: 'Test?', conversationId: 99_999_999 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('ciclu complet de conversație: creare prin chat, listare, mesaje, ștergere', async () => {
    const chatRes = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { question: 'Întrebare de test pentru integrare?' },
    });
    expect(chatRes.statusCode).toBe(200);
    expect(chatRes.headers['content-type']).toContain('text/event-stream');

    const events = chatRes.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)));

    const conversation = events.find((e) => e.type === 'conversation');
    const done = events.find((e) => e.type === 'done');
    expect(conversation).toBeDefined();
    expect(done).toBeDefined();
    expect(events.filter((e) => e.type === 'token').map((e) => e.content).join('')).toBe('Răspuns de test [S1].');

    const conversationId = conversation.conversationId as number;
    const messages = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` });
    const parsed = messages.json() as Array<{ role: string; content: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].role).toBe('user');
    expect(parsed[1].role).toBe('assistant');

    const del = await app.inject({ method: 'DELETE', url: `/api/conversations/${conversationId}` });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` });
    expect(after.json()).toHaveLength(0);
  });

  it('chat cu tool-uri de facturi: execută tool-ul și răspunde fără citări fallback', async () => {
    // Runda 1: modelul cere un tool; runda 2: răspunsul final.
    vi.mocked(chatStream)
      .mockImplementationOnce(async function* () {
        yield { toolCalls: [{ function: { name: 'get_balance', arguments: { period: 'current_month' } } }] };
      })
      .mockImplementationOnce(async function* () {
        yield { content: 'Balanța pe luna curentă este echilibrată.' };
      });

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { question: 'Care este balanța dintre venituri și cheltuieli?' },
    });
    expect(res.statusCode).toBe(200);

    const events = res.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)));

    const tool = events.find((e) => e.type === 'tool');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('get_balance');
    expect(tool.summary).toMatch(/balanța/i);

    expect(events.filter((e) => e.type === 'token').map((e) => e.content).join('')).toBe(
      'Balanța pe luna curentă este echilibrată.'
    );

    // Al doilea apel către model primește rezultatul tool-ului ca mesaj role "tool".
    const secondCallMessages = vi.mocked(chatStream).mock.calls[vi.mocked(chatStream).mock.calls.length - 1][0];
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.tool_name).toBe('get_balance');
    expect(JSON.parse(toolMessage!.content)).toHaveProperty('invoiced_issued');

    // Răspuns bazat pe tool-uri, fără etichete [Sn] → fără citări fallback.
    const done = events.find((e) => e.type === 'done');
    expect(done.citations).toEqual([]);

    const conversationId = events.find((e) => e.type === 'conversation').conversationId as number;
    const messages = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` });
    // Mesajele intermediare (assistant cu tool_calls, tool) nu se persistă.
    expect(messages.json()).toHaveLength(2);
    await app.inject({ method: 'DELETE', url: `/api/conversations/${conversationId}` });
  });

  it('GET /api/admin/status raportează contoarele', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documents).toHaveProperty('active');
    expect(typeof body.chunks).toBe('number');
  });
});
