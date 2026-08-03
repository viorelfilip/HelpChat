export type DocumentStatus = 'active' | 'indexing' | 'failed' | 'deleted';
export type ChunkSource = 'text' | 'ocr' | 'video';
export type MessageRole = 'user' | 'assistant';

export interface DocumentSummary {
  id: number;
  relPath: string;
  title: string;
  status: DocumentStatus;
  pageCount: number | null;
  chunkCount: number;
  ocrChunkCount: number;
  indexedAt: string | null;
  error: string | null;
  updatedAt: string;
}

export interface Citation {
  /** Eticheta din răspuns, ex. "S1" */
  label: string;
  chunkId: number;
  documentId: number;
  relPath: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  /** Fragmentul de text care susține răspunsul */
  snippet: string;
  source: ChunkSource;
  /** Capturi de ecran atașate fragmentului (URL-uri servite de backend) */
  media: Array<{ id: number; url: string }>;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: MessageRole;
  content: string;
  citations: Citation[];
  /** Întrebări propuse pentru continuarea discuției (doar pe mesajele asistentului). */
  suggestions: string[];
  createdAt: string;
}

/** Sugestiile afișate la deschiderea unei conversații noi. */
export interface StarterSuggestions {
  /** Temele acoperite de documentele indexate. */
  topics: string[];
  /** Întrebări gata de trimis. */
  questions: string[];
}

export interface Conversation {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface IngestionEvent {
  id: number;
  level: 'info' | 'warn' | 'error';
  stage: string;
  relPath: string | null;
  message: string;
  createdAt: string;
}

export interface IndexStatus {
  running: boolean;
  documents: { active: number; indexing: number; failed: number; deleted: number };
  chunks: number;
  lastScanAt: string | null;
}

/** Evenimente SSE trimise de /api/chat */
export type ChatStreamEvent =
  | { type: 'conversation'; conversationId: number }
  | { type: 'sources'; citations: Citation[] }
  | { type: 'token'; content: string }
  /** Modelul execută un tool de facturi (ex. "Consult facturile de plătit"). */
  | { type: 'tool'; name: string; summary: string }
  | { type: 'done'; messageId: number; citations: Citation[] }
  /** Continuări propuse, emise după `done`. */
  | { type: 'suggestions'; messageId: number; items: string[] }
  | { type: 'error'; message: string };
