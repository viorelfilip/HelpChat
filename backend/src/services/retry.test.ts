import { describe, expect, it, vi } from 'vitest';
import { isTransientNetworkError, withRetry } from './retry.js';

const noSleep = () => Promise.resolve();

describe('isTransientNetworkError', () => {
  it('recunoaște erorile de rețea, inclusiv din cause', () => {
    expect(isTransientNetworkError(new Error('fetch failed'))).toBe(true);
    expect(isTransientNetworkError(new Error('The operation was aborted due to timeout'))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))).toBe(true);
    expect(isTransientNetworkError(new Error('connect ENETUNREACH 192.168.101.60:5432'))).toBe(true);
  });

  it('erorile de aplicație nu sunt tranzitorii', () => {
    expect(isTransientNetworkError(new Error('model "inexistent" not found'))).toBe(false);
    expect(isTransientNetworkError(new Error('Ollama http://x → HTTP 400: bad request'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('reușita imediată nu reîncearcă', async () => {
    const fn = vi.fn(async () => 42);
    expect(await withRetry(fn, 3, 1, noSleep)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('eroarea tranzitorie se reîncearcă până la succes', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
      .mockResolvedValue('ok');
    expect(await withRetry(fn, 3, 1, noSleep)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('eroarea non-tranzitorie se propagă imediat', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('model not found'));
    await expect(withRetry(fn, 3, 1, noSleep)).rejects.toThrow('model not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('după epuizarea încercărilor, ultima eroare se propagă', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(withRetry(fn, 3, 1, noSleep)).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
