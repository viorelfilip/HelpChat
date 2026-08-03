import type {
  ChatMessage,
  ChatStreamEvent,
  Conversation,
  DocumentSummary,
  IndexStatus,
  IngestionEvent,
  StarterSuggestions,
} from '@practica/shared';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const api = {
  listConversations: () => getJson<Conversation[]>('/api/conversations'),
  getMessages: (id: number) => getJson<ChatMessage[]>(`/api/conversations/${id}/messages`),
  deleteConversation: (id: number) => fetch(`/api/conversations/${id}`, { method: 'DELETE' }),
  getDocuments: () => getJson<DocumentSummary[]>('/api/documents'),
  getStatus: () => getJson<IndexStatus>('/api/admin/status'),
  getEvents: (limit = 100) => getJson<IngestionEvent[]>(`/api/admin/events?limit=${limit}`),
  reindex: () => fetch('/api/admin/reindex', { method: 'POST' }),
  health: () => getJson<{ ok: boolean }>('/api/health'),
  getSuggestions: () => getJson<StarterSuggestions>('/api/suggestions'),
};

/**
 * Trimite o întrebare și consumă fluxul SSE al răspunsului.
 * EventSource nu suportă POST, deci parsăm manual stream-ul fetch-ului.
 */
export async function streamChat(
  question: string,
  conversationId: number | null,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, conversationId: conversationId ?? undefined }),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Serverul a răspuns cu ${res.status}. ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (line) onEvent(JSON.parse(line.slice(6)) as ChatStreamEvent);
    }
  }
}
