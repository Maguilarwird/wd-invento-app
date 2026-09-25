// src/otbb-report.js
// Cliente del nuevo nodo de pipeline "otbb-service": sube el maestro OTBB ya
// exportado, detecta el universo de productos, crea el job de redacción del
// reporte PDF y descarga el resultado. Todas las llamadas pasan por el
// backend de invento-app (/api/otbb-report/*), nunca directo al servicio
// externo — mismo patrón que sentiment-model/multitag-api.

import axios from 'axios';
import { API_BASE } from './config';

const UPLOAD_TIMEOUT_MS = 60000;
const JOB_TIMEOUT_MS = 30000;
const PDF_POLL_INTERVAL_MS = 4000;
// Una corrida real de 12 hilos de prueba tardó 4m34s (Claude redacta 9 secciones
// con max_tokens alto y recién ahí llama a render_pdf). Con 5 minutos el front
// se rendía antes de que el job terminara y mostraba un "timeout" sobre un job
// que en realidad iba a salir bien. Un archivo de cliente tarda más todavía.
const PDF_POLL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Sube el workbook del maestro OTBB (Blob/ArrayBuffer del .xlsx) a otbb-service.
 * Devuelve { upload_id, universo_detectado: [{producto, n_hilos}] }.
 */
export async function uploadOtbbMasterForReport(fileBuffer, filename, { signal } = {}) {
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), filename);

  const response = await axios.post(`${API_BASE}/api/otbb-report/uploads`, form, {
    timeout: UPLOAD_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

/**
 * Crea el job de redacción del reporte. `config` es el ReportConfig completo
 * (cliente, periodo_label, upload_id, productos_seleccionados, enfoque, ...).
 * Devuelve { job_id, status }.
 */
export async function createOtbbReportJob(config, { signal } = {}) {
  const response = await axios.post(`${API_BASE}/api/otbb-report/jobs`, config, {
    timeout: JOB_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Descarga el PDF de un job ya terminado.
 */
async function fetchOtbbReportPdf(jobId, { signal } = {}) {
  const response = await axios.get(`${API_BASE}/api/otbb-report/jobs/${encodeURIComponent(jobId)}/pdf`, {
    responseType: 'blob',
    timeout: UPLOAD_TIMEOUT_MS,
    signal,
  });
  return response.data;
}

/**
 * Sondea el ESTADO del job (no el PDF a ciegas) hasta que termine, y recién ahí
 * baja el PDF. Sondear el PDF directamente hace que un job fallado se vea igual
 * que uno lento: 404 hasta que se agota el tiempo, con un mensaje genérico que
 * esconde el error real del backend.
 *
 * `onProgress` recibe el estado crudo en cada vuelta, para que la UI pueda
 * mostrar algo mejor que un spinner mudo en una espera de varios minutos.
 */
export async function pollOtbbReportPdf(jobId, {
  signal,
  isCancelled = () => false,
  onProgress = () => {},
} = {}) {
  const deadline = Date.now() + PDF_POLL_TIMEOUT_MS;
  let consecutiveNetworkErrors = 0;
  // Un job recién creado siempre existe en otbb-service. Si empieza a dar 404 es
  // que el servicio se reinició y perdió el estado en memoria — típicamente
  // porque corre con `--reload` vigilando data/, y la escritura del upload o del
  // PDF dispara el reinicio. Esperar 20 minutos por un job que ya no existe solo
  // esconde el problema.
  const JOB_GONE_GRACE_MS = 45000;
  let firstSeenMissingAt = null;

  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error('CANCELLED');
    try {
      const response = await axios.get(`${API_BASE}/api/otbb-report/jobs/${encodeURIComponent(jobId)}`, {
        timeout: UPLOAD_TIMEOUT_MS,
        signal,
        validateStatus: () => true,
      });
      consecutiveNetworkErrors = 0;

      const job = response.data || {};
      if (response.status === 200 && job.status) {
        firstSeenMissingAt = null;
        onProgress(job);
        if (job.status === 'done') return await fetchOtbbReportPdf(jobId, { signal });
        if (job.status === 'error') {
          throw new Error(job.detail || 'El job de reporte falló en otbb-service.');
        }
      } else if (response.status >= 500) {
        // 502/503/504 son fallas de transporte del proxy (ej. `read ECONNRESET`
        // por un socket keep-alive cerrado del otro lado), no del job. Matar un
        // reporte de 6 minutos por un sondeo fallido de ~90 es exactamente el
        // bug que hacía ver "El reporte PDF no se generó" sobre un job sano.
        consecutiveNetworkErrors += 1;
        if (consecutiveNetworkErrors >= 10) {
          throw new Error(job.error || `otbb-service respondió ${response.status} de forma sostenida.`);
        }
      } else if (response.status === 404) {
        firstSeenMissingAt = firstSeenMissingAt ?? Date.now();
        if (Date.now() - firstSeenMissingAt > JOB_GONE_GRACE_MS) {
          throw new Error(
            'El job desapareció de otbb-service: el servicio se reinició mientras generaba el reporte. '
            + 'Suele pasar al correr uvicorn con --reload, porque escribir en data/uploads o data/outputs '
            + 'dispara el reinicio y mata el job. Relanzá el servicio sin --reload '
            + '(o con --reload-exclude "data/*" --reload-exclude "static/*") y volvé a intentar.'
          );
        }
      }
    } catch (e) {
      if (e.message === 'CANCELLED') throw e;
      // Un error propio del job (status "error") no es de red: se propaga.
      if (!e.isAxiosError && e.message) throw e;
      consecutiveNetworkErrors += 1;
      if (consecutiveNetworkErrors >= 10) {
        throw new Error('Se perdió la conexión con otbb-service mientras se generaba el reporte.');
      }
    }
    await sleep(PDF_POLL_INTERVAL_MS);
  }
  throw new Error(
    'El reporte sigue generándose y superó el tiempo de espera del navegador. '
    + 'El job puede terminar igual en otbb-service: revisa data/outputs o vuelve a consultar el estado.'
  );
}
