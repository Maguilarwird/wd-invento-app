import axios from 'axios';

export const DEFAULT_SENTIMENT_BATCH_SIZE = 150;
export const DEFAULT_SENTIMENT_CONCURRENCY = 3;

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export function createSentimentService({
  baseUrl,
  axiosClient = axios,
  timeoutMs = 60000,
  batchSize = DEFAULT_SENTIMENT_BATCH_SIZE,
  concurrency = DEFAULT_SENTIMENT_CONCURRENCY,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const safeBatchSize = Math.max(1, Number(batchSize) || DEFAULT_SENTIMENT_BATCH_SIZE);
  const safeConcurrency = Math.max(1, Number(concurrency) || DEFAULT_SENTIMENT_CONCURRENCY);

  async function classifyBatch({ texts, lang = 'es', signal }) {
    if (!normalizedBaseUrl) {
      throw new Error('SENTIMENT_API_URL no está configurada.');
    }
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('texts debe ser un arreglo no vacío.');
    }

    const chunks = chunk(texts, safeBatchSize);
    const results = new Array(chunks.length);
    let next = 0;

    const worker = async () => {
      while (next < chunks.length) {
        if (signal?.aborted) return;
        const index = next;
        next += 1;
        const response = await axiosClient.post(
          `${normalizedBaseUrl}/predict/batch`,
          { texts: chunks[index], lang },
          { timeout: timeoutMs, signal },
        );
        results[index] = response.data?.results || [];
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(safeConcurrency, chunks.length) }, () => worker()),
    );

    return results.flat();
  }

  return { classifyBatch };
}
