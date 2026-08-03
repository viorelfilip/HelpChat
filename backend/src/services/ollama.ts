import { config } from '../config.js';
import { withRetry } from './retry.js';

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Pe mesajele assistant: apelurile de tool cerute de model. */
  tool_calls?: OllamaToolCall[];
  /** Pe mesajele tool: numele tool-ului al cărui rezultat este content. */
  tool_name?: string;
}

/** Definiție de tool în formatul nativ Ollama /api/chat. */
export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Delta emisă de chatStream: text de răspuns și/sau apeluri de tool. */
export interface OllamaChatDelta {
  content?: string;
  toolCalls?: OllamaToolCall[];
}

/** POST cu retry pe erori tranzitorii de rețea (rețeaua internă mai cade). */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Ollama ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data = (await res.json()) as T & { error?: string };
    if (data.error) throw new Error(`Ollama ${url} → ${data.error}`);
    return data;
  });
}

/** Generează embeddings pentru unul sau mai multe texte (batch). */
export async function embed(input: string[]): Promise<number[][]> {
  if (input.length === 0) return [];
  const data = await postJson<{ embeddings: number[][] }>(`${config.OLLAMA_URL_EMBED}/api/embed`, {
    model: config.EMBED_MODEL,
    input,
    keep_alive: config.OLLAMA_KEEP_ALIVE,
  });
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== input.length) {
    throw new Error(`Ollama embed: am primit ${data.embeddings?.length ?? 0} vectori pentru ${input.length} texte`);
  }
  for (const v of data.embeddings) {
    if (v.length !== config.EMBED_DIM) {
      throw new Error(
        `Modelul ${config.EMBED_MODEL} produce vectori de ${v.length} dimensiuni, dar EMBED_DIM=${config.EMBED_DIM}. ` +
          `Corectează .env și reindexează.`
      );
    }
  }
  return data.embeddings;
}

/**
 * Chat cu streaming pe API-ul nativ Ollama, opțional cu tool-uri (function
 * calling). Emite deltele din `message.content` și apelurile de tool din
 * `message.tool_calls` — câmpul `reasoning`/`thinking` al modelelor thinking
 * este ignorat intenționat (vezi MODELE-LOCALE-INDECO.md §5).
 */
export async function* chatStream(
  messages: OllamaChatMessage[],
  tools?: OllamaToolDefinition[]
): AsyncGenerator<OllamaChatDelta> {
  const res = await fetch(`${config.OLLAMA_URL_CHAT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.CHAT_MODEL,
      messages,
      stream: true,
      keep_alive: config.OLLAMA_KEEP_ALIVE,
      options: { temperature: config.CHAT_TEMPERATURE },
      ...(tools?.length ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama chat → HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const json = JSON.parse(line) as {
        message?: { content?: string; tool_calls?: OllamaToolCall[] };
        error?: string;
        done?: boolean;
      };
      if (json.error) throw new Error(`Ollama chat → ${json.error}`);
      if (json.message?.tool_calls?.length) yield { toolCalls: json.message.tool_calls };
      if (json.message?.content) yield { content: json.message.content };
    }
  }
}

/** Apel non-streaming (folosit la titluri de conversație și în teste). */
export async function chat(messages: OllamaChatMessage[]): Promise<string> {
  const data = await postJson<{ message: { content: string } }>(`${config.OLLAMA_URL_CHAT}/api/chat`, {
    model: config.CHAT_MODEL,
    messages,
    stream: false,
    keep_alive: config.OLLAMA_KEEP_ALIVE,
    options: { temperature: config.CHAT_TEMPERATURE },
  });
  return data.message.content;
}

/** OCR: extrage textul dintr-o imagine PNG (base64) cu modelul dedicat. */
export async function ocrImage(imageBase64: string): Promise<string> {
  const data = await postJson<{ response: string }>(`${config.OLLAMA_URL_OCR}/api/generate`, {
    model: config.OCR_MODEL,
    prompt: 'Extrage tot textul din imagine, păstrând ordinea de citire. Returnează doar textul.',
    images: [imageBase64],
    stream: false,
    keep_alive: config.OLLAMA_KEEP_ALIVE,
  });
  return data.response;
}

/** Descrie un cadru dintr-o înregistrare de ecran cu modelul vision (pe .55). */
export async function describeFrame(imageBase64: string): Promise<string> {
  const data = await postJson<{ response: string }>(`${config.OLLAMA_URL_VISION}/api/generate`, {
    model: config.VISION_MODEL,
    prompt:
      'Aceasta este o captură dintr-o înregistrare de ecran a unei aplicații software. ' +
      'Descrie concis, în română: 1) ce ecran/modul este afișat; 2) ce acțiune pare să se execute; ' +
      '3) transcrie textul important vizibil (titluri, câmpuri, butoane, mesaje, valori). ' +
      'Maxim 150 de cuvinte. Fii precis, nu inventa.',
    images: [imageBase64],
    stream: false,
    keep_alive: config.OLLAMA_KEEP_ALIVE,
    // Fără num_predict: qwen3-vl e model thinking — un plafon mic e consumat
    // integral de raționamentul intern și răspunsul iese gol (done_reason: length).
    options: { temperature: 0.1 },
  });
  return data.response;
}

/** Verifică la pornire că serverele răspund și modelele configurate există. */
export async function checkOllama(): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const targets: Array<[string, string]> = [
    [config.OLLAMA_URL_CHAT, config.CHAT_MODEL],
    [config.OLLAMA_URL_EMBED, config.EMBED_MODEL],
    [config.OLLAMA_URL_OCR, config.OCR_MODEL],
    [config.OLLAMA_URL_VISION, config.VISION_MODEL],
  ];
  for (const [url, model] of targets) {
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      const data = (await res.json()) as { models: Array<{ name: string; model: string }> };
      const found = data.models.some((m) => m.name === model || m.model === model || m.name === `${model}:latest`);
      if (!found) problems.push(`Modelul "${model}" nu există pe ${url}`);
    } catch {
      problems.push(`Serverul Ollama ${url} nu răspunde`);
    }
  }
  return { ok: problems.length === 0, problems };
}
