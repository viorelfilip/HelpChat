import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage, Citation, Conversation } from '@practica/shared';
import { api, streamChat } from '../api/client';

function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/** .docx nu are paginare fixă — afișăm doar fișierul; la video afișăm minutul. */
function formatRef(c: Citation): string {
  const lower = c.relPath.toLowerCase();
  if (lower.endsWith('.docx')) return c.relPath;
  if (lower.endsWith('.mp4')) {
    const range = c.pageStart === c.pageEnd ? `min. ${mmss(c.pageStart)}` : `min. ${mmss(c.pageStart)}–${mmss(c.pageEnd)}`;
    return `${c.relPath} · ${range}`;
  }
  const pages = c.pageStart === c.pageEnd ? `pag. ${c.pageStart}` : `pag. ${c.pageStart}–${c.pageEnd}`;
  return `${c.relPath} · ${pages}`;
}

interface DraftMessage {
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  streaming?: boolean;
  /** Tool-ul de facturi în curs de execuție (ex. „Consult facturile de plătit"). */
  toolStatus?: string;
}

export function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<DraftMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCitation, setOpenCitation] = useState<Citation | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(() => {
    api.listConversations().then(setConversations).catch(() => {});
  }, []);

  useEffect(refreshConversations, [refreshConversations]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const openConversation = useCallback((id: number | null) => {
    setActiveId(id);
    setOpenCitation(null);
    setError(null);
    if (id === null) {
      setMessages([]);
      return;
    }
    api
      .getMessages(id)
      .then((msgs: ChatMessage[]) =>
        setMessages(msgs.map((m) => ({ role: m.role, content: m.content, citations: m.citations })))
      )
      .catch(() => setError('Nu am putut încărca conversația.'));
  }, []);

  async function send() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setQuestion('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: q, citations: [] },
      { role: 'assistant', content: '', citations: [], streaming: true },
    ]);

    const updateLast = (fn: (m: DraftMessage) => DraftMessage) =>
      setMessages((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1])]);

    try {
      await streamChat(q, activeId, (event) => {
        if (event.type === 'conversation') {
          setActiveId(event.conversationId);
        } else if (event.type === 'token') {
          updateLast((m) => ({ ...m, content: m.content + event.content, toolStatus: undefined }));
        } else if (event.type === 'tool') {
          updateLast((m) => ({ ...m, toolStatus: event.summary }));
        } else if (event.type === 'done') {
          updateLast((m) => ({ ...m, citations: event.citations, streaming: false }));
        } else if (event.type === 'error') {
          setError(event.message);
          updateLast((m) => ({ ...m, streaming: false }));
        }
      });
    } catch (err) {
      setError((err as Error).message);
      updateLast((m) => ({ ...m, streaming: false }));
    } finally {
      setBusy(false);
      refreshConversations();
    }
  }

  async function removeConversation(id: number) {
    await api.deleteConversation(id);
    if (id === activeId) openConversation(null);
    refreshConversations();
  }

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <button className="btn primary full" onClick={() => openConversation(null)}>
          + Conversație nouă
        </button>
        <ul className="conversation-list">
          {conversations.map((c) => (
            <li key={c.id} className={c.id === activeId ? 'active' : ''}>
              <button className="conversation-title" onClick={() => openConversation(c.id)} title={c.title}>
                {c.title}
              </button>
              <button className="icon-btn" title="Șterge conversația" onClick={() => removeConversation(c.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="chat-main">
        <div className="messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <h2>Întreabă documentele</h2>
              <p>
                Răspunsurile se bazează exclusiv pe PDF-urile indexate și includ citări cu fișierul și pagina sursă.
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`message ${m.role}`}>
              <div className="bubble">
                {m.role === 'assistant' ? (
                  <>
                    {m.streaming && m.toolStatus && (
                      <div className="tool-status">
                        <em>⚙ {m.toolStatus}…</em>
                      </div>
                    )}
                    <ReactMarkdown>{m.content || (m.streaming ? '…' : '')}</ReactMarkdown>
                    {m.streaming && <span className="cursor">▍</span>}
                    {m.citations.length > 0 && (
                      <div className="citations">
                        {m.citations.map((c) => (
                          <button
                            key={c.label}
                            className="citation-chip"
                            onClick={() => setOpenCitation(openCitation?.chunkId === c.chunkId ? null : c)}
                            title={formatRef(c)}
                          >
                            [{c.label}] {formatRef(c)}
                            {c.source === 'ocr' && <span className="ocr-badge">OCR</span>}
                            {c.source === 'video' && <span className="ocr-badge">VIDEO</span>}
                            {c.media.length > 0 && <span className="ocr-badge media-badge">📷 {c.media.length}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    {m.citations.some((c) => c.media.length > 0) && (
                      <div className="media-strip">
                        {m.citations
                          .flatMap((c) => c.media.map((img) => ({ ...img, label: c.label, ref: formatRef(c) })))
                          .map((img) => (
                            <a key={img.id} href={img.url} target="_blank" rel="noreferrer" title={`[${img.label}] ${img.ref}`}>
                              <img src={img.url} alt={`Captură din [${img.label}] ${img.ref}`} loading="lazy" />
                            </a>
                          ))}
                      </div>
                    )}
                  </>
                ) : (
                  m.content
                )}
              </div>
            </div>
          ))}
          {error && <div className="error-banner">Eroare: {error}</div>}
        </div>

        {openCitation && (
          <div className="citation-panel">
            <div className="citation-panel-header">
              <strong>
                [{openCitation.label}] {formatRef(openCitation)}
              </strong>
              <button className="icon-btn" onClick={() => setOpenCitation(null)}>
                ✕
              </button>
            </div>
            <blockquote>{openCitation.snippet}</blockquote>
            {openCitation.media.length > 0 && (
              <div className="media-strip">
                {openCitation.media.map((img) => (
                  <a key={img.id} href={img.url} target="_blank" rel="noreferrer">
                    <img src={img.url} alt={`Captură din ${openCitation.relPath}`} loading="lazy" />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="composer">
          <textarea
            value={question}
            placeholder="Pune o întrebare despre documente…"
            rows={2}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn primary" disabled={busy || !question.trim()} onClick={send}>
            {busy ? 'Se generează…' : 'Trimite'}
          </button>
        </div>
      </main>
    </div>
  );
}
