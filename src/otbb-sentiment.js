// src/otbb-sentiment.js
// Análisis de sentimiento por hilo: cada mensaje del hilo se envía a
// sentiment-model (vía /api/sentiment/batch) y se agrega a nivel de
// conversación. El sentiment_tag del hilo es la clase con mayor probabilidad
// promedio entre sus mensajes; overall_sentiment_score es el promedio del
// log-prob (log de la probabilidad de la clase predicha) de cada mensaje.

import axios from 'axios';
import { API_BASE } from './config';

const SENTIMENT_BATCH_SIZE = 150;
const SENTIMENT_CONCURRENCY = 3;
const SENTIMENT_TIMEOUT_MS = 60000;
const MIN_PROB = 1e-9;

function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return '';
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function logProbOf(result) {
  const probas = result?.probas || {};
  const prob = Number(probas[result?.label]);
  return Math.log(Number.isFinite(prob) && prob > 0 ? prob : MIN_PROB);
}

/**
 * Agrega mensajes ya clasificados (agrupados por thread_id) a nivel de hilo.
 * messagesByThread: Map<thread_id, Array<{ label, probas, logProb }>>
 */
export function aggregateThreadSentiment(messagesByThread) {
  const result = new Map();
  messagesByThread.forEach((messages, threadId) => {
    if (!messages.length) {
      result.set(threadId, { SentimentHilo: '', overall_sentiment_score: '' });
      return;
    }
    const classTotals = {};
    let logProbSum = 0;
    messages.forEach(m => {
      logProbSum += m.logProb;
      Object.entries(m.probas || {}).forEach(([cls, p]) => {
        classTotals[cls] = (classTotals[cls] || 0) + Number(p || 0);
      });
    });
    let bestClass = '';
    let bestAvg = -Infinity;
    Object.entries(classTotals).forEach(([cls, total]) => {
      const avg = total / messages.length;
      if (avg > bestAvg) { bestAvg = avg; bestClass = cls; }
    });
    result.set(threadId, {
      SentimentHilo: bestClass,
      overall_sentiment_score: round(logProbSum / messages.length, 3),
    });
  });
  return result;
}

/**
 * Clasifica el sentimiento de cada mensaje de cada hilo y agrega el resultado
 * a nivel de conversación. Devuelve Map<thread_id, { SentimentHilo, overall_sentiment_score }>.
 */
export async function analyzeThreadSentiment(threadDetailRows = [], {
  setProgress = () => {},
  isCancelled = () => false,
  signal,
  lang = 'es',
} = {}) {
  // Se puntúa el MISMO texto que se etiqueta: `clean_text` (sin banners, sin el
  // historial ya citado, vacío en las filas repetidas del archivo). Con el
  // crudo, el sentimiento terminaba puntuando avisos de phishing, firmas y
  // cadenas citadas — y contando dos veces los correos que el export duplica.
  // Si el motor de exclusiones no corrió, `clean_text` es el crudo igual.
  const items = threadDetailRows
    .map(detail => ({
      thread_id: String(detail.thread_id || ''),
      text: String(detail.clean_text ?? detail.content_hilo ?? '').trim(),
    }))
    .filter(item => item.thread_id && item.text.length > 0);

  if (items.length === 0) return new Map();

  const batches = [];
  for (let i = 0; i < items.length; i += SENTIMENT_BATCH_SIZE) {
    batches.push(items.slice(i, i + SENTIMENT_BATCH_SIZE));
  }

  const batchResults = new Array(batches.length);
  let completed = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (isCancelled()) throw new Error('CANCELLED');
      const index = nextIndex;
      nextIndex += 1;
      if (index >= batches.length) return;

      const batch = batches[index];
      const response = await axios.post(`${API_BASE}/api/sentiment/batch`, {
        texts: batch.map(item => item.text),
        lang,
      }, { timeout: SENTIMENT_TIMEOUT_MS, signal });
      batchResults[index] = response.data?.results || [];

      completed += 1;
      setProgress(Math.round((completed / batches.length) * 100));
    }
  };

  const workers = Math.min(SENTIMENT_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const messagesByThread = new Map();
  batches.forEach((batch, bIdx) => {
    const results = batchResults[bIdx] || [];
    batch.forEach((item, i) => {
      const res = results[i];
      if (!res) return;
      if (!messagesByThread.has(item.thread_id)) messagesByThread.set(item.thread_id, []);
      messagesByThread.get(item.thread_id).push({
        label: res.label,
        probas: res.probas || {},
        logProb: logProbOf(res),
      });
    });
  });

  return aggregateThreadSentiment(messagesByThread);
}
