// src/otbb-exclusiones.js
// Primera interacción con el dataset crudo, antes de threading.js: cada
// mensaje pasa por motor-exclusiones (capa determinista, sin LLM) para
// marcar ruido operativo — fuera de oficina, rebotes, banners institucionales,
// notificaciones — y filas que el archivo trae repetidas o insistencias
// reales. El motor NUNCA borra texto, solo agrega columnas (ver
// motor-exclusiones/README.md, "Contrato de salida"); acá se agregan como
// `__exclusion_*` sobre cada fila cruda, y threading.js las consume si están
// (`formatThreadTranscript`/`buildThreadRows`, ver exclusionOf()).
//
// Es aditivo y opcional a propósito: si el servicio no está configurado o
// falla, se devuelven las filas crudas sin tocar y el resto del pipeline
// corre exactamente igual que antes (mismo patrón que sentiment/WMB en
// OpenBlackBox.jsx — un sub-flujo que no bloquea el resultado principal).

import axios from 'axios';
import { API_BASE } from './config';
import { cellToText } from './threading';

// Margen bajo el MAX_MENSAJES_POR_LOTE del servicio (default 5000, ver
// motor-exclusiones/README.md): un hilo nunca se puede partir entre dos
// llamadas, así que los lotes se arman por hilo completo, no por conteo fijo.
const BATCH_MAX_MENSAJES = 4000;
const EXCLUSIONES_TIMEOUT_MS = 90000;
const EXCLUSIONES_CONCURRENCY = 2;

/**
 * Agrupa mensajes en lotes sin partir un hilo entre dos lotes. Un hilo más
 * grande que `maxPorLote` por sí solo queda en su propio lote sobredimensionado
 * — inevitable si no se puede partir, y se espera que sea raro en la práctica.
 */
function batchByThread(mensajes, maxPorLote) {
  const porHilo = new Map();
  const orden = [];
  mensajes.forEach(m => {
    const key = m.hilo || `__solo_${m.id}__`;
    if (!porHilo.has(key)) { porHilo.set(key, []); orden.push(key); }
    porHilo.get(key).push(m);
  });

  const lotes = [];
  let actual = [];
  orden.forEach(key => {
    const grupo = porHilo.get(key);
    if (actual.length && actual.length + grupo.length > maxPorLote) {
      lotes.push(actual);
      actual = [];
    }
    actual.push(...grupo);
  });
  if (actual.length) lotes.push(actual);
  return lotes;
}

/**
 * Corre motor-exclusiones sobre las filas crudas de un upload (antes de
 * threading.js). `config` es la misma forma que espera `buildThreadRows`
 * (threadColumn, dateColumn, subjectColumn, contentColumn) más
 * `messageIdColumn`/`fromColumn`, que threading.js hoy sólo re-infiere
 * internamente — se recalculan igual acá vía `inferThreadColumns` en el
 * caller (ver OpenBlackBox.jsx) para no duplicar esa lógica de inferencia.
 *
 * Devuelve { rows, applied, resumen, avisos }. `rows` son las mismas
 * `rawRows` (mismo orden, mismo largo) con `__exclusion_*` agregado a cada
 * fila que el motor pudo evaluar — nunca se quita ni reordena nada, para que
 * el resto del pipeline (buildThreadRows y todo lo que sigue) reciba
 * exactamente la forma que ya espera.
 */
export async function runExclusionMotor(rawRows, config, {
  setProgress = () => {},
  isCancelled = () => false,
  signal,
  contexto = [],
} = {}) {
  const { threadColumn, dateColumn, subjectColumn, contentColumn, messageIdColumn, fromColumn } = config;

  if (!contentColumn || !Array.isArray(rawRows) || rawRows.length === 0) {
    return { rows: rawRows, applied: false, resumen: null, avisos: [] };
  }

  const mensajes = rawRows.map((row, index) => ({
    id: index,
    texto: cellToText(row[contentColumn]).trim(),
    asunto: subjectColumn ? cellToText(row[subjectColumn]).trim() : '',
    hilo: threadColumn ? cellToText(row[threadColumn]).trim() : '',
    fecha: dateColumn ? cellToText(row[dateColumn]).trim() : '',
    remitente: fromColumn ? cellToText(row[fromColumn]).trim() : '',
    msg_id: messageIdColumn ? cellToText(row[messageIdColumn]).trim() : '',
  }));

  const lotes = batchByThread(mensajes, BATCH_MAX_MENSAJES);
  const resultadosPorLote = new Array(lotes.length);
  const resumenPorLote = new Array(lotes.length);
  const avisos = new Set();
  let completados = 0;
  let siguiente = 0;

  const worker = async () => {
    while (true) {
      if (isCancelled()) throw new Error('CANCELLED');
      const index = siguiente;
      siguiente += 1;
      if (index >= lotes.length) return;

      const response = await axios.post(`${API_BASE}/api/exclusiones/batch`, {
        mensajes: lotes[index],
        contexto,
      }, { timeout: EXCLUSIONES_TIMEOUT_MS, signal });

      resultadosPorLote[index] = response.data?.mensajes || [];
      resumenPorLote[index] = response.data?.resumen || null;
      (response.data?.avisos || []).forEach(a => avisos.add(a));

      completados += 1;
      setProgress(Math.round((completados / lotes.length) * 100));
    }
  };

  const workers = Math.min(EXCLUSIONES_CONCURRENCY, lotes.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const porId = new Map();
  resultadosPorLote.forEach(lote => {
    (lote || []).forEach(m => porId.set(m.id, m));
  });

  const rows = rawRows.map((row, index) => {
    const r = porId.get(index);
    if (!r) return row;
    return {
      ...row,
      __exclusion_aplicado: true,
      __exclusion_excluido: r.excluido === true,
      __exclusion_categoria: r.categoria || '',
      __exclusion_regla_id: r.regla_id || '',
      __exclusion_evidencia: r.evidencia || '',
      __exclusion_tratamiento: r.tratamiento || '',
      __exclusion_texto_para_prompt: r.texto_para_prompt,
      __exclusion_fila_estado: r.fila_estado || '',
      __exclusion_insistencia_n: r.insistencia_n ?? 0,
    };
  });

  // El ahorro de texto y las insistencias los calcula el servicio por lote
  // (sobre chars reales, no sobre lo que se ve acá): se suman, no se recalculan,
  // para que el número que se muestra sea el mismo que reporta el motor.
  const sumarLotes = (campo) => resumenPorLote.reduce(
    (total, r) => total + (Number(r?.[campo]) || 0), 0,
  );
  const charsOriginal = sumarLotes('chars_original');
  const charsParaPrompt = sumarLotes('chars_para_prompt');

  const resumen = {
    mensajes: mensajes.length,
    excluidos: rows.filter(r => r.__exclusion_excluido).length,
    duplicados_archivo: rows.filter(r => String(r.__exclusion_fila_estado || '').startsWith('duplicado')).length,
    insistencias: sumarLotes('insistencias'),
    banners_removidos: sumarLotes('banners_removidos'),
    chars_original: charsOriginal,
    chars_para_prompt: charsParaPrompt,
    ahorro_pct: charsOriginal
      ? Math.round(((charsOriginal - charsParaPrompt) / charsOriginal) * 1000) / 10
      : 0,
    lotes: lotes.length,
  };

  return { rows, applied: true, resumen, avisos: [...avisos] };
}

/**
 * Arma los datos del checkpoint de exclusiones (ventana 1): estadística
 * descriptiva básica del archivo + el desglose de lo que el motor encontró.
 * Pura y sin red — corre sobre lo que `buildThreadRows` ya calculó (antes de
 * Claude), así que no depende de que el etiquetado haya corrido.
 */
export function summarizeExclusionCheckpoint({
  rawData = [],
  columns = [],
  threadRows = [],
  detailRows = [],
  resumen = {},
} = {}) {
  const dates = threadRows.flatMap(r => [r.fecha_inicio, r.fecha_fin]).filter(Boolean).sort();

  const categoryCounts = new Map();
  let totalExcluidos = 0;
  detailRows.forEach(row => {
    if (row.excluido_ruido === 'True') {
      totalExcluidos += 1;
      const cat = row.categoria_exclusion || 'Sin categoría';
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }
  });
  const categorias = [...categoryCounts.entries()]
    .map(([categoria, n]) => ({
      categoria,
      n,
      pct: totalExcluidos ? Math.round((n / totalExcluidos) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.n - a.n);

  return {
    descriptive: {
      totalRows: rawData.length,
      totalThreads: threadRows.length,
      dateStart: dates[0] || '',
      dateEnd: dates[dates.length - 1] || '',
      columnCount: columns.length,
    },
    exclusion: {
      mensajesEvaluados: resumen.mensajes ?? 0,
      excluidos: resumen.excluidos ?? totalExcluidos,
      duplicadosArchivo: resumen.duplicados_archivo ?? 0,
      ahorroTextoPct: resumen.ahorro_pct ?? 0,
      hilosConInsistencia: threadRows.filter(r => Number(r.n_insistencias_hilo) > 0).length,
      categorias,
    },
  };
}
