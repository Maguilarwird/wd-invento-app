import axios from 'axios';

export const DEFAULT_EXCLUSIONES_TIMEOUT_MS = 90000;

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

// A diferencia de sentiment-service.js / multitag-service.js, este servicio
// NO trocea por su cuenta: src/otbb-exclusiones.js arma los lotes en el
// front, respetando la regla de motor-exclusiones de no partir un hilo entre
// dos llamadas (algo que este backend no puede reconstruir después). Acá
// solo se reenvía el lote tal cual, con la API key server-side.
export function createExclusionesService({
  baseUrl,
  apiKey,
  axiosClient = axios,
  timeoutMs = DEFAULT_EXCLUSIONES_TIMEOUT_MS,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const safeTimeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_EXCLUSIONES_TIMEOUT_MS);

  async function procesarLote({ mensajes, contexto = [], signal }) {
    if (!normalizedBaseUrl) {
      throw new Error('MOTOR_EXCLUSIONES_URL no está configurada.');
    }
    if (!Array.isArray(mensajes) || mensajes.length === 0) {
      throw new Error('mensajes debe ser un arreglo no vacío.');
    }

    const response = await axiosClient.post(
      `${normalizedBaseUrl}/procesar-lote`,
      { mensajes, contexto },
      {
        timeout: safeTimeoutMs,
        signal,
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      },
    );
    return response.data; // { mensajes, resumen, avisos }
  }

  return { procesarLote };
}
