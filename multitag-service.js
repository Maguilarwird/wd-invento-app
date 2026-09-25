import axios from 'axios';

export const DEFAULT_MULTITAG_MAX_SAMPLE = 200;
export const DEFAULT_MULTITAG_CONCURRENCY = 5;

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function validateTagOnlyPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) return false;
  const values = Object.values(data);
  return values.length > 0 && values.every(value => value === 0 || value === 1);
}

function validateTagSinglePayload(data) {
  return data
    && typeof data === 'object'
    && Array.isArray(data.categorias)
    && typeof data.response === 'string';
}

export function createMultitagService({
  baseUrl,
  token,
  axiosClient = axios,
  timeoutMs = 120000,
  maxSample = DEFAULT_MULTITAG_MAX_SAMPLE,
  concurrency = DEFAULT_MULTITAG_CONCURRENCY,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const safeMaxSample = Math.max(1, Number(maxSample) || DEFAULT_MULTITAG_MAX_SAMPLE);
  const safeConcurrency = Math.max(1, Number(concurrency) || DEFAULT_MULTITAG_CONCURRENCY);

  async function classifyItem(item, client, taggingMode, signal) {
    const endpoint = taggingMode === 'single' ? '/tag_single' : '/tag_only';
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

    try {
      const response = await axiosClient.post(
        `${normalizedBaseUrl}${endpoint}`,
        { text: item.text, client },
        { timeout: timeoutMs, headers, signal },
      );
      const valid = taggingMode === 'single'
        ? validateTagSinglePayload(response.data)
        : validateTagOnlyPayload(response.data);

      if (!valid) {
        throw new Error(`Contrato inválido recibido desde ${endpoint}`);
      }

      return { index: item.index, ok: true, data: response.data };
    } catch (error) {
      const detail = error.response?.data?.error
        ?? error.response?.data?.detail
        ?? error.message
        ?? String(error);
      return {
        index: item.index,
        ok: false,
        error: String(detail),
        status: error.response?.status ?? null,
      };
    }
  }

  async function classifySample({ items, client, taggingMode, signal }) {
    if (!normalizedBaseUrl) {
      throw new Error('MULTITAG_API_URL no está configurada.');
    }
    if (!/^[a-z0-9-]+$/i.test(String(client || ''))) {
      throw new Error('Cliente productivo inválido.');
    }
    if (!['single', 'multi'].includes(taggingMode)) {
      throw new Error('Modo de etiquetado inválido.');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('La muestra debe contener al menos un texto.');
    }
    if (items.length > safeMaxSample) {
      throw new Error(`La muestra supera el máximo de ${safeMaxSample} llamadas.`);
    }

    const normalizedItems = items.map((item) => {
      const index = Number(item?.index);
      const text = String(item?.text ?? '').trim();
      if (!Number.isInteger(index) || index < 0 || !text) {
        throw new Error('Cada elemento debe incluir index entero y text no vacío.');
      }
      return { index, text };
    });

    const results = new Array(normalizedItems.length);
    let next = 0;
    const worker = async () => {
      while (next < normalizedItems.length) {
        if (signal?.aborted) return;
        const position = next;
        next += 1;
        results[position] = await classifyItem(normalizedItems[position], client, taggingMode, signal);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(safeConcurrency, normalizedItems.length) },
        () => worker(),
      ),
    );

    const completedResults = results.filter(Boolean);
    return {
      endpoint: taggingMode === 'single' ? '/tag_single' : '/tag_only',
      requested: normalizedItems.length,
      succeeded: completedResults.filter(result => result.ok).length,
      failed: completedResults.filter(result => !result.ok).length,
      results: completedResults,
    };
  }

  return { classifySample };
}
