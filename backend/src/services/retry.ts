const TRANSIENT_PATTERN = /fetch failed|timed? ?out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|aborted|EADDRNOTAVAIL/i;

export function isTransientNetworkError(err: unknown): boolean {
  const parts = [
    (err as Error)?.message,
    (err as Error)?.name,
    ((err as { cause?: Error })?.cause as Error)?.message,
    ((err as { cause?: { code?: string } })?.cause as { code?: string })?.code,
  ];
  return TRANSIENT_PATTERN.test(parts.filter(Boolean).join(' '));
}

/**
 * Reîncearcă apelurile eșuate din cauze tranzitorii de rețea (serverele Ollama
 * și DB-ul sunt în rețeaua internă, care mai are întreruperi). Erorile de alt
 * tip (model inexistent, payload greșit) se propagă imediat.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 10_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === attempts) throw err;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}
