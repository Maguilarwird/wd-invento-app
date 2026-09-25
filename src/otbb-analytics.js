/**
 * Analítica OTBB en modo hilo. Puro cálculo sobre filas ya etiquetadas: sin
 * React y sin fetch, para que el dashboard pueda recalcular sobre cualquier
 * subconjunto filtrado y los tests puedan importarlo desde node.
 */
import {
  caidaDistribution,
  conversationFlowState,
  desenlaceDistribution,
  funnelGates,
  GESTION_SIN_GESTION,
  ORIGEN_INBOUND,
  ORIGEN_OUTBOUND,
} from './otbb-taxonomia.js';

export const GESTION_ENTREGO_SIN_RESPUESTA = 'Entregó documentos y nadie respondió jamás';
export const DESENLACE_COLOCACION = 'Colocación verificada (curse, incluye bypass por otro canal)';

/** Etiqueta corta para UI: quita el sufijo entre paréntesis del catálogo. */
export function shortFlowLabel(label = '') {
  const trimmed = String(label || '').trim();
  const short = trimmed.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return short || trimmed;
}

export function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

export function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export function splitTagList(value) {
  return String(value || '').split(';').map(item => item.trim()).filter(Boolean);
}

export function countByField(rows = [], field, fallback = 'Sin dato') {
  return rows.reduce((acc, row) => {
    const value = String(row[field] || '').trim() || fallback;
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

export function topCountLabel(counts = {}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || '';
}

// El catálogo de banca no trae origen: sólo las exclusiones lo declaran. El campo
// del catálogo de flujo, "Origen_conversación" (Inbound/Outbond), se resuelve por
// conversación, así que para una hoja por tipificación se resume con el valor
// dominante y su peso cuando la tipificación llega por los dos lados.
export function observedOrigenByCode(taggedRows = []) {
  const byCode = new Map();
  taggedRows.forEach(row => {
    const code = String(row.CategoriaAsignada || '').trim();
    if (!code || !String(row.Origen || '').trim()) return;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  });
  const out = {};
  byCode.forEach((rows, code) => {
    const counts = countByField(rows, 'Origen');
    const top = topCountLabel(counts);
    const share = pct(counts[top], rows.length);
    out[code] = share >= 100 ? top : `${top} (${share}%)`;
  });
  return out;
}

export function isWmcCode(code) {
  return String(code || '').startsWith('WMC');
}

// El modelo a veces omite n. Si la evidencia cae en un turno, se ancla ahí;
// si no, se deja vacío: no se inventa el turno 1.
export function resolveFrictionTurn(friction = {}, nTurnos, turnTexts = []) {
  const n = Number(friction.n);
  if (Number.isFinite(n) && n >= 1 && n <= nTurnos) return Math.trunc(n);
  const evidence = String(friction.evidencia || '').trim().toLowerCase();
  if (!evidence) return '';
  const idx = turnTexts.findIndex(text => String(text || '').toLowerCase().includes(evidence));
  return idx >= 0 ? idx + 1 : '';
}

export function isExclusionRow(row = {}) {
  return isWmcCode(row.CategoriaAsignada);
}

export function withoutExclusions(rows = []) {
  return rows.filter(row => !isExclusionRow(row));
}

export function formatFrictionStarts(fricciones = []) {
  return fricciones
    .filter(f => f.id && f.n)
    .map(f => `${f.id}:${f.n}`)
    .join('; ');
}

export function resolveFrictionsForThread(fricciones = [], detailRows = []) {
  const sorted = [...detailRows].sort((a, b) => Number(a.orden_hilo) - Number(b.orden_hilo));
  const texts = sorted.map(row => [row.subject_hilo, row.content_hilo].filter(Boolean).join(' '));
  return fricciones.map(f => ({
    ...f,
    n: resolveFrictionTurn(f, sorted.length, texts) || '',
  }));
}

export function projectFrictionsOnDetails(detailRows = [], taggedRows = []) {
  const byThread = new Map((taggedRows || []).map(row => [String(row.thread_id || ''), row]));
  return detailRows.map(detail => {
    const parent = byThread.get(String(detail.thread_id || '')) || {};
    const ids = (parent.__fricciones || [])
      .filter(f => Number(f.n) === Number(detail.orden_hilo))
      .map(f => f.id);
    return {
      ...detail,
      friccion_inicia_aqui: ids.length ? 'Sí' : '',
      friccion_ids_en_este_hilo: ids.join('; '),
    };
  });
}

// WMC ya no sale de un matcher: se proyecta desde la etiqueta del turno.
export function applyWmcFromTurnos(threadRows = [], detailRows = [], taggedRows = [], metaMap = {}) {
  const byThread = new Map((taggedRows || []).map(row => [String(row.thread_id || ''), row]));
  const hitsByThread = new Map();
  const enrichedDetails = detailRows.map(detail => {
    const parent = byThread.get(String(detail.thread_id || '')) || {};
    const turno = (parent.__turnos || []).find(t => Number(t.n) === Number(detail.orden_hilo));
    const code = String(turno?.code || '').trim();
    if (!isWmcCode(code)) {
      return { ...detail, wmc_code: '', wmc_evidencia: '', wmc_tratamiento: '', wmc_regla: '' };
    }
    const payload = {
      code,
      evidencia: (turno?.evidence || []).join(' | '),
      turno: detail.orden_hilo,
      tratamiento: metaMap[code]?.tratamiento || '',
    };
    if (!hitsByThread.has(detail.thread_id)) hitsByThread.set(detail.thread_id, []);
    hitsByThread.get(detail.thread_id).push(payload);
    return {
      ...detail,
      wmc_code: code,
      wmc_evidencia: payload.evidencia,
      wmc_tratamiento: payload.tratamiento,
      wmc_regla: '',
    };
  });

  const enrichedThreads = threadRows.map(row => {
    const hits = hitsByThread.get(row.thread_id) || [];
    const codes = [...new Set(hits.map(hit => hit.code).filter(Boolean))];
    return {
      ...row,
      wmc_codes: codes.join('; '),
      wmc_evidencias: hits.map(hit => `T${hit.turno}: ${hit.evidencia}`).join(' | '),
      wmc_turnos: hits.map(hit => hit.turno).join('; '),
      wmc_tratamientos: [...new Set(hits.map(hit => hit.tratamiento).filter(Boolean))].join(' | '),
      wmc_hits_count: hits.length,
      n_interacciones_wmc: hits.length,
      pct_interacciones_wmc: pct(hits.length, Number(row.n_interacciones || row.n_mensajes_hilo || 0)),
    };
  });

  return { threadRows: enrichedThreads, detailRows: enrichedDetails };
}

export function finalizeThreadAnnotations(taggedRows = [], detailRows = [], metaMap = {}) {
  const detailsByThread = new Map();
  detailRows.forEach(detail => {
    const id = String(detail.thread_id || '');
    if (!detailsByThread.has(id)) detailsByThread.set(id, []);
    detailsByThread.get(id).push(detail);
  });

  const withFriction = taggedRows.map(row => {
    const details = detailsByThread.get(String(row.thread_id || '')) || [];
    const resolved = resolveFrictionsForThread(row.__fricciones || [], details);
    return { ...row, __fricciones: resolved, FriccionIniciaEnHilo: formatFrictionStarts(resolved) };
  });

  const withWmc = applyWmcFromTurnos(withFriction, detailRows, withFriction, metaMap);
  return {
    taggedRows: withWmc.threadRows,
    detailRows: projectFrictionsOnDetails(withWmc.detailRows, withWmc.threadRows),
  };
}

export function rowResponseHours(row) {
  const hours = Number(row.tiempo_respuesta_promedio_horas);
  if (Number.isFinite(hours)) return hours;
  const minutes = Number(row.tiempo_respuesta_promedio_min);
  return Number.isFinite(minutes) ? minutes / 60 : null;
}

// "El cliente insistió" del mockup es una fricción concreta del catálogo, no una
// macro: el cliente tuvo que forzar el seguimiento porque nadie respondió.
export const FRICTION_INSISTENCIA = 'FR-EC-02';

function mean(values) {
  return values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

export function resolutionDays(row = {}) {
  const hours = Number(row.duracion_hilo_horas);
  return Number.isFinite(hours) ? hours / 24 : null;
}

export function getThreadAnalytics(rows = []) {
  const total = rows.length || 0;
  const avgResponseHours = mean(rows.map(rowResponseHours).filter(n => Number.isFinite(n)));
  const avgResolutionDays = mean(rows.map(resolutionDays).filter(n => Number.isFinite(n)));
  // Una conversación puede tener varias fricciones: se cuenta cobertura, no
  // distribución, así que los conteos no suman el total.
  const macroFrictions = {};
  const frictions = new Map();
  let withFriction = 0;
  let insistencia = 0;
  rows.forEach(r => {
    const ids = splitTagList(r.Fricciones);
    const nombres = splitTagList(r.FriccionesNombres);
    if (ids.length) withFriction += 1;
    if (ids.includes(FRICTION_INSISTENCIA)) insistencia += 1;
    ids.forEach((id, idx) => {
      const prev = frictions.get(id);
      if (prev) prev.n += 1;
      else frictions.set(id, { id, nombre: nombres[idx] || id, n: 1 });
    });
    splitTagList(r.MacroFricciones).forEach(macro => {
      macroFrictions[macro] = (macroFrictions[macro] || 0) + 1;
    });
  });

  const states = rows.map(conversationFlowState);
  const inBase = states.filter(s => s.enBase);
  return {
    total,
    avgResponseHours,
    avgResolutionDays,
    base: inBase.length,
    neta: states.filter(s => s.neta).length,
    casoActivo: states.filter(s => s.casoActivo).length,
    derived: states.filter(s => !s.enBase).length,
    invisible: inBase.filter(s => s.bucket === 'invisible').length,
    // "Cerrado" = el hilo ya no espera nada: se ganó o se decidió que no.
    cerrados: inBase.filter(s => s.bucket === 'ganado' || s.bucket === 'decidido').length,
    withFriction,
    insistencia,
    macroFrictions: Object.entries(macroFrictions).sort((a, b) => b[1] - a[1]),
    topFrictions: Array.from(frictions.values()).sort((a, b) => b.n - a.n),
  };
}

export function getFlowAnalytics(rows = []) {
  const total = rows.length || 0;
  const states = rows.map(conversationFlowState);
  const countBy = (values, fallback) => values.reduce((acc, value) => {
    const key = String(value || '').trim() || fallback;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const byJourney = {};
  rows.forEach((row, i) => {
    if (isExclusionRow(row)) return;
    const journey = journeyOf(row);
    byJourney[journey] = byJourney[journey] || { rows: [], states: [], desenlaces: {}, fricciones: {} };
    byJourney[journey].rows.push(row);
    byJourney[journey].states.push(states[i]);
    const desenlace = states[i].desenlace || 'Sin clasificar';
    byJourney[journey].desenlaces[desenlace] = (byJourney[journey].desenlaces[desenlace] || 0) + 1;
    splitTagList(row.MacroFricciones).forEach(macro => {
      byJourney[journey].fricciones[macro] = (byJourney[journey].fricciones[macro] || 0) + 1;
    });
  });

  const journeyTotal = rows.reduce((n, row) => n + (isExclusionRow(row) ? 0 : 1), 0);
  const journeys = Object.entries(byJourney)
    .map(([journey, data]) => {
      const responseValues = data.rows.map(rowResponseHours).filter(Number.isFinite);
      const base = data.states.filter(s => s.enBase).length;
      return {
        journey,
        n: data.rows.length,
        pct: pct(data.rows.length, journeyTotal),
        topDesenlace: topCountLabel(data.desenlaces),
        topFriccion: topCountLabel(data.fricciones) || 'Sin fricción',
        ganados: data.states.filter(s => s.bucket === 'ganado').length,
        base,
        avgResponseHours: responseValues.length ? round1(responseValues.reduce((a, b) => a + b, 0) / responseValues.length) : 0,
        rows: data.rows,
      };
    })
    .sort((a, b) => b.n - a.n);

  const conFriccion = rows.filter(row => splitTagList(row.Fricciones).length > 0).length;

  return {
    total,
    states,
    byOrigen: countBy(states.map(s => s.origen), 'Sin metadata'),
    byApertura: countBy(states.map(s => s.apertura), 'No Aplica'),
    byGestion: countBy(states.map(s => s.gestion), 'Sin clasificar'),
    byDesenlace: countBy(states.map(s => s.desenlace), 'Sin clasificar'),
    funnel: funnelGates(rows),
    desenlaces: desenlaceDistribution(rows),
    caidas: caidaDistribution(rows),
    journeys,
    fricciones: { conFriccion },
  };
}

// ─── Etapas del journey ───────────────────────────────────────────────────────
// Orden canónico de `modulos_journey` en el catálogo de banca. Cada hilo cae en
// exactamente una etapa: es una distribución, no una cascada que se atraviesa.
export const JOURNEY_ORDER = [
  'Venta / Originación',
  'Activación',
  'Postventa / Gestión',
  'Cobranza',
  'Retención / Fidelización',
  'Cierre o Desvinculación',
];

export const SIN_JOURNEY = 'Sin journey';
export const SIN_SEGMENTO = 'Sin segmento';
export const SIN_PRODUCTO = 'Sin producto';

export function journeyOf(row = {}) {
  return String(row.JourneyConversacional || '').trim() || SIN_JOURNEY;
}

/** Etapas presentes en las filas, en orden canónico y con las desconocidas al final. */
export function orderedStages(rows = []) {
  const scoped = withoutExclusions(rows);
  const present = new Set(scoped.map(journeyOf));
  const known = JOURNEY_ORDER.filter(stage => present.has(stage));
  const rest = [...present].filter(stage => !JOURNEY_ORDER.includes(stage)).sort();
  return [...known, ...rest];
}

/**
 * Volumen por etapa con la caída real medida dentro de cada una: de los casos
 * comerciales activos de la etapa, cuántos llegan a desenlace visible y cuántos
 * se apagan. No es una cascada entre etapas — esa progresión no existe en la
 * data, un hilo pertenece a una sola etapa.
 */
export function stageFunnel(rows = []) {
  const scoped = withoutExclusions(rows);
  const byStage = new Map();
  scoped.forEach(row => {
    const stage = journeyOf(row);
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(row);
  });
  const total = scoped.length;
  const maxN = Math.max(1, ...[...byStage.values()].map(list => list.length));

  return orderedStages(scoped).map(stage => {
    const stageRows = byStage.get(stage) || [];
    const states = stageRows.map(conversationFlowState);
    const activos = states.filter(s => s.casoActivo);
    const visibles = activos.filter(s => s.desenlaceVisible).length;
    return {
      stage,
      n: stageRows.length,
      pct: pct(stageRows.length, total),
      width: pct(stageRows.length, maxN),
      casoActivo: activos.length,
      desenlaceVisible: visibles,
      apagados: activos.length - visibles,
      pctVisible: pct(visibles, activos.length),
    };
  });
}

/** "Abierto" = sin desenlace resuelto al corte: vivo o sin desenlace visible. */
export function isOpenThread(row = {}) {
  const { bucket, enBase } = conversationFlowState(row);
  return enBase && (bucket === 'vivo' || bucket === 'invisible');
}

/** Distribución por etapa de los hilos que siguen abiertos. Suma 100%. */
export function openThreadsByStage(rows = []) {
  const open = withoutExclusions(rows).filter(isOpenThread);
  const counts = countByField(open.map(row => ({ stage: journeyOf(row) })), 'stage', SIN_JOURNEY);
  const stages = orderedStages(open).map(stage => ({
    stage,
    n: counts[stage] || 0,
    pct: pct(counts[stage] || 0, open.length),
  }));
  const top = stages.reduce((best, item) => (item.n > (best?.n || 0) ? item : best), null);
  return { total: open.length, stages, top };
}

// ─── Heatmap de intensidad ────────────────────────────────────────────────────
// La taxonomía no trae un nivel de fricción, así que la intensidad se define por
// cuántas fricciones distintas viven en el hilo.
// ponytail: corte fijo en 2 y 3. Si más adelante hay severidad por fricción en
// el catálogo, esto se reemplaza por el promedio ponderado de severidad.
export const INTENSITY_LEVELS = [
  { key: 'baja', label: 'Baja' },
  { key: 'media', label: 'Media' },
  { key: 'alta', label: 'Alta' },
];

export function frictionIntensity(row = {}) {
  const n = splitTagList(row.Fricciones).length;
  if (n >= 3) return 'alta';
  if (n === 2) return 'media';
  return 'baja';
}

/** Etapa × intensidad. Cada fila suma 100% de los hilos de esa etapa. */
export function intensityHeatmap(rows = []) {
  const scoped = withoutExclusions(rows);
  const byStage = new Map();
  scoped.forEach(row => {
    const stage = journeyOf(row);
    if (!byStage.has(stage)) byStage.set(stage, { baja: 0, media: 0, alta: 0, n: 0 });
    const cell = byStage.get(stage);
    cell[frictionIntensity(row)] += 1;
    cell.n += 1;
  });
  return orderedStages(scoped).map(stage => {
    const cell = byStage.get(stage);
    return {
      stage,
      n: cell.n,
      levels: INTENSITY_LEVELS.map(level => ({
        ...level,
        n: cell[level.key],
        pct: pct(cell[level.key], cell.n),
      })),
    };
  });
}

// ─── Conversaciones críticas ──────────────────────────────────────────────────
export function silenceDays(row = {}) {
  const hours = Number(row.silencio_maximo_horas);
  if (Number.isFinite(hours)) return round1(hours / 24);
  const duration = Number(row.duracion_hilo_horas);
  return Number.isFinite(duration) ? round1(duration / 24) : 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

/**
 * Hilos que piden intervención: siguen abiertos, tienen caso comercial activo y
 * su silencio está en el decil peor del conjunto que se está mirando. El umbral
 * es relativo al filtro activo, así que hacer zoom a un producto lento no
 * esconde sus propios casos.
 */
export function criticalThreads(rows = []) {
  const candidates = withoutExclusions(rows).filter(row => isOpenThread(row) && conversationFlowState(row).casoActivo);
  const sorted = candidates.map(silenceDays).sort((a, b) => a - b);
  const threshold = percentile(sorted, 0.9);
  return {
    threshold,
    items: candidates
      .filter(row => silenceDays(row) >= threshold)
      .sort((a, b) => silenceDays(b) - silenceDays(a))
      .map(row => ({
        id: String(row.thread_id || row.__otbbRowIndex || '—'),
        stage: journeyOf(row),
        days: silenceDays(row),
        friction: splitTagList(row.FriccionesNombres)[0] || 'Sin fricción detectada',
        evidence: row.EvidenciaFricciones || '',
      })),
  };
}

// ─── Zoom: segmento → producto ────────────────────────────────────────────────
export function segmentOf(row = {}) {
  return String(row.SegmentoNegocio || '').trim() || SIN_SEGMENTO;
}

export function productOf(row = {}) {
  return String(row.ProductoNegocio || '').trim() || SIN_PRODUCTO;
}

/**
 * Opciones del filtro derivadas de las filas presentes, no del catálogo: no se
 * ofrecen productos con cero hilos. Los hilos sin metadata de negocio quedan en
 * un bucket propio y visible, nunca descartados en silencio.
 */
export function zoomOptions(rows = []) {
  const bySegment = new Map();
  rows.forEach(row => {
    const segment = segmentOf(row);
    if (!bySegment.has(segment)) bySegment.set(segment, new Map());
    const products = bySegment.get(segment);
    const product = productOf(row);
    products.set(product, (products.get(product) || 0) + 1);
  });
  return [...bySegment.entries()]
    .map(([segment, products]) => ({
      segment,
      n: [...products.values()].reduce((a, b) => a + b, 0),
      products: [...products.entries()]
        .map(([product, n]) => ({ product, n }))
        .sort((a, b) => b.n - a.n),
    }))
    .sort((a, b) => b.n - a.n);
}

export function applyZoom(rows = [], { segmento = '', producto = '', etapa = '' } = {}) {
  return rows.filter(row =>
    (!etapa || !isExclusionRow(row)) &&
    (!segmento || segmentOf(row) === segmento) &&
    (!producto || productOf(row) === producto) &&
    (!etapa || journeyOf(row) === etapa)
  );
}

// ─── Nuevos filtros: periodo × producto × canal ───────────────────────────────

/** Extrae YYYY-MM de fecha_inicio. Devuelve '' si no hay fecha. */
function periodOf(row = {}) {
  const iso = String(row.fecha_inicio || '').trim();
  return iso.length >= 7 ? iso.slice(0, 7) : '';
}

/** Lista de períodos únicos presentes en las filas, en orden descendente. */
export function availablePeriods(rows = []) {
  const set = new Set();
  rows.forEach(row => {
    const p = periodOf(row);
    if (p) set.add(p);
  });
  return [...set].sort((a, b) => b.localeCompare(a));
}

/** Lista de productos únicos presentes en las filas. */
export function availableProductos(rows = []) {
  const counts = new Map();
  rows.forEach(row => {
    const p = productOf(row);
    counts.set(p, (counts.get(p) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([product, n]) => ({ product, n }));
}

/**
 * Filtra filas por periodo (YYYY-MM), producto y canal.
 * Canal es un campo futuro; si la fila no lo tiene se trata como 'email'.
 */
export function applyFilters(rows = [], { periodo = '', producto = '', canal = '' } = {}) {
  return rows.filter(row => {
    if (periodo && periodOf(row) !== periodo) return false;
    if (producto && productOf(row) !== producto) return false;
    if (canal && canal !== 'todos') {
      const rowCanal = String(row.Canal || 'email').trim().toLowerCase();
      if (rowCanal !== canal.toLowerCase()) return false;
    }
    return true;
  });
}

// ─── Fricciones por etapa ─────────────────────────────────────────────────────

/**
 * Devuelve, por etapa en orden canónico, el listado de fricciones con su
 * conteo de menciones y el total de hilos afectados en esa etapa.
 * La estructura alimenta el gráfico de barras apiladas horizontales.
 */
export function getFrictionsByStage(rows = []) {
  const scoped = withoutExclusions(rows);

  // Índice global de nombres de fricciones por id
  const nameById = new Map();
  scoped.forEach(row => {
    const ids = splitTagList(row.Fricciones);
    const names = splitTagList(row.FriccionesNombres);
    ids.forEach((id, i) => {
      if (!nameById.has(id) && names[i]) nameById.set(id, names[i]);
    });
  });

  // Agrupa por etapa
  const byStage = new Map();
  scoped.forEach(row => {
    const stage = journeyOf(row);
    if (!byStage.has(stage)) byStage.set(stage, { total: 0, frictions: new Map() });
    const cell = byStage.get(stage);
    cell.total += 1;
    const ids = splitTagList(row.Fricciones);
    if (ids.length) {
      ids.forEach(id => {
        cell.frictions.set(id, (cell.frictions.get(id) || 0) + 1);
      });
    }
  });

  return orderedStages(scoped).map(stage => {
    const cell = byStage.get(stage) || { total: 0, frictions: new Map() };
    const frictionList = [...cell.frictions.entries()]
      .map(([id, n]) => ({ id, nombre: nameById.get(id) || id, n }))
      .sort((a, b) => b.n - a.n);
    const totalMentions = frictionList.reduce((s, f) => s + f.n, 0);
    return {
      stage,
      total: cell.total,
      totalMentions,
      pctHilos: pct(frictionList.reduce((s, f) => (f.n > 0 ? s + 1 : s), 0), cell.total),
      frictions: frictionList,
    };
  });
}

/** Conjunto global de fricciones ordenadas por total de menciones (para la leyenda). */
export function globalFrictionLegend(frictionsByStage = []) {
  const totals = new Map();
  const names = new Map();
  frictionsByStage.forEach(({ frictions }) => {
    frictions.forEach(({ id, nombre, n }) => {
      totals.set(id, (totals.get(id) || 0) + n);
      if (!names.has(id) && nombre) names.set(id, nombre);
    });
  });
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ id, nombre: names.get(id) || id, n }));
}

// ─── Sankey: Origen → Gestión → Desenlace ────────────────────────────────────

const SANKEY_FIRST_COLUMN = {
  origen: { field: 'origen', label: 'Origen del contacto' },
  apertura: { field: 'apertura', label: 'Tipo de apertura' },
};

/**
 * Devuelve nodos y links para el diagrama de Sankey de tres columnas.
 * Con `origen` filtra Inbound/Outbound; en ese caso la primera columna usa
 * Apertura para no repetir un solo nodo de origen.
 */
export function getSankeyFlows(rows = [], { origen = '', firstColumn = '' } = {}) {
  const scoped = withoutExclusions(rows).filter(row => {
    if (!origen) return true;
    return conversationFlowState(row).origen === origen;
  });

  const firstKey = firstColumn || (origen ? 'apertura' : 'origen');
  const firstCol = SANKEY_FIRST_COLUMN[firstKey] || SANKEY_FIRST_COLUMN.origen;
  const SIN = 'Sin dato';

  const counts = new Map(); // 'col0||gestion||desenlace' → n
  scoped.forEach(row => {
    const state = conversationFlowState(row);
    const col0 = state[firstCol.field] || SIN;
    const gestion = state.gestion || SIN;
    const desenlace = state.desenlace || SIN;
    const key = `${col0}||${gestion}||${desenlace}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const nodeMap = new Map();
  const links = [];

  const getNode = (label, col) => {
    const key = `${col}:${label}`;
    if (!nodeMap.has(key)) {
      nodeMap.set(key, { id: key, label, col, value: 0 });
    }
    return nodeMap.get(key);
  };

  counts.forEach((n, key) => {
    const [col0, gestion, desenlace] = key.split('||');
    const c0Node = getNode(col0, 0);
    const gNode = getNode(gestion, 1);
    const dNode = getNode(desenlace, 2);
    c0Node.value += n;
    gNode.value += n;
    dNode.value += n;
    links.push({ source: c0Node.id, target: gNode.id, value: n });
    links.push({ source: gNode.id, target: dNode.id, value: n });
  });

  const linkMap = new Map();
  links.forEach(link => {
    const key = `${link.source}→${link.target}`;
    if (!linkMap.has(key)) linkMap.set(key, { ...link });
    else linkMap.get(key).value += link.value;
  });

  return {
    nodes: [...nodeMap.values()].sort((a, b) => a.col - b.col || b.value - a.value),
    links: [...linkMap.values()],
    total: scoped.length,
    columnLabels: [
      firstCol.label,
      'Qué pasó en la conversación',
      'Desenlace',
    ],
  };
}

/** Dos Sankeys paralelos: Inbound y Outbound, cada uno con su analítica. */
export function getSankeyFlowsSplit(rows = []) {
  const scoped = withoutExclusions(rows);
  const inboundRows = scoped.filter(row => conversationFlowState(row).origen === ORIGEN_INBOUND);
  const outboundRows = scoped.filter(row => conversationFlowState(row).origen === ORIGEN_OUTBOUND);

  return {
    inbound: {
      ...getSankeyFlows(inboundRows, { origen: ORIGEN_INBOUND, firstColumn: 'apertura' }),
      analytics: getFlowAnalytics(inboundRows),
    },
    outbound: {
      ...getSankeyFlows(outboundRows, { origen: ORIGEN_OUTBOUND, firstColumn: 'apertura' }),
      analytics: getFlowAnalytics(outboundRows),
    },
  };
}

// ─── Quién queda esperando ────────────────────────────────────────────────────

/**
 * Hilos con al menos un mensaje interno (reenvío a colega).
 */
export function getDerivacionStats(rows = []) {
  const scoped = withoutExclusions(rows);
  const n = scoped.filter(row => {
    if (String(row.derivado || '').toLowerCase() === 'true') return true;
    return Number(row.n_internos || 0) > 0;
  }).length;
  return { n, total: scoped.length };
}

/**
 * Total de reenvíos internos (Num_derivados) sobre el corte, no solo cuántos
 * hilos tuvieron al menos uno (eso ya lo da getDerivacionStats).
 */
export function getDerivacionSummary(rows = []) {
  const scoped = withoutExclusions(rows);
  const totalDerivaciones = scoped.reduce((sum, row) => sum + (Number(row.Num_derivados) || 0), 0);
  return { totalDerivaciones, total: scoped.length };
}

/**
 * Sentimiento por hilo (SentimentHilo/overall_sentiment_score de sentiment-model).
 * Hilos sin mensajes clasificables quedan fuera del promedio y la distribución.
 */
export function getSentimentStats(rows = []) {
  const scoped = withoutExclusions(rows).filter(row => Number.isFinite(Number(row.overall_sentiment_score)));
  const avgScore = mean(scoped.map(row => Number(row.overall_sentiment_score)));
  const byLabel = {};
  scoped.forEach(row => {
    const label = String(row.SentimentHilo || '').trim();
    if (!label) return;
    byLabel[label] = (byLabel[label] || 0) + 1;
  });
  return { total: scoped.length, avgScore, byLabel };
}

/** Recuadros inferiores del Sankey: claves alineadas al catálogo y buckets. */
export function getSankeyFooterStats(rows = [], analytics = {}) {
  const scoped = withoutExclusions(rows);
  const total = scoped.length || analytics.total || 0;
  return {
    total,
    monologos: analytics.byGestion?.[GESTION_SIN_GESTION] || 0,
    sinDesenlace: analytics.desenlaces?.porBucket?.find?.(([k]) => k === 'invisible')?.[1] || 0,
    colocacion: analytics.byDesenlace?.[DESENLACE_COLOCACION] || 0,
    entregaron: analytics.byGestion?.[GESTION_ENTREGO_SIN_RESPUESTA] || 0,
  };
}

/**
 * Las cuatro métricas del panel "Composición de la conversación".
 * - esperandoBanco: caso activo y el cliente escribió; el banco aún no respondió
 * - silencioLargo: al menos un silencio de 30+ días dentro del hilo
 * - sentimientoNegativo: SentimentHilo === 'NEG' (sentiment-model); si el hilo
 *   no fue analizado, cae al campo Sentimiento del catálogo como respaldo.
 * - emailsSinRespuesta: solo el banco escribió; el cliente nunca contestó
 */
export function getWaitingStats(rows = []) {
  const scoped = withoutExclusions(rows);
  let esperandoBanco = 0;
  let silencioLargo = 0;
  let sentimientoNegativo = 0;
  let emailsSinRespuesta = 0;

  const negWords = ['negativo', 'negative', 'neg'];

  scoped.forEach(row => {
    const state = conversationFlowState(row);
    const dir = String(row.ultimo_mensaje_direccion || '').trim().toLowerCase();
    const composicion = String(row.composicion_hilo || '').trim().toLowerCase();
    const silencio = Number(row.silencio_maximo_horas);
    const modelSentiment = String(row.SentimentHilo || '').trim().toUpperCase();
    const sent = String(row.Sentimiento || row.sentimiento || '').trim().toLowerCase();
    const pending = String(row.pendiente || row.pendiente_deterministico || '').toLowerCase() === 'true';
    const isNegative = modelSentiment ? modelSentiment === 'NEG' : negWords.some(w => sent.includes(w));

    if (state.casoActivo && (dir === 'recibido' || pending)) esperandoBanco += 1;
    if (Number.isFinite(silencio) && silencio >= 720) silencioLargo += 1;
    if (isNegative) sentimientoNegativo += 1;
    if (composicion === 'outbound') emailsSinRespuesta += 1;
  });

  return { esperandoBanco, silencioLargo, sentimientoNegativo, emailsSinRespuesta };
}

// ─── Largo del hilo ───────────────────────────────────────────────────────────

const LENGTH_BUCKETS = [
  { label: '1 - 2 mensajes', min: 1, max: 2 },
  { label: '3 - 4 mensajes', min: 3, max: 4 },
  { label: '5 - 8 mensajes', min: 5, max: 8 },
  { label: '9 - 15 mensajes', min: 9, max: 15 },
  { label: '16 o más', min: 16, max: Infinity },
];

export function getThreadLengthDistribution(rows = []) {
  const counts = LENGTH_BUCKETS.map(b => ({ ...b, n: 0 }));
  rows.forEach(row => {
    const n = Number(row.n_mensajes_hilo || 0);
    const bucket = counts.find(b => n >= b.min && n <= b.max);
    if (bucket) bucket.n += 1;
  });
  const max = Math.max(1, ...counts.map(b => b.n));
  return counts.map(b => ({ ...b, width: pct(b.n, max) }));
}

// ─── Temas por etapa ──────────────────────────────────────────────────────────

/**
 * Top N subcategorías/temas dentro de una etapa del journey.
 * Usa MacroCategorias (campo libre del catálogo) si existe, fallback a FriccionesNombres.
 */
export function getTopicsByStage(rows = [], stage = '', limit = 6) {
  const scoped = withoutExclusions(rows).filter(row =>
    !stage || journeyOf(row) === stage
  );
  const counts = new Map();
  scoped.forEach(row => {
    const topics = splitTagList(row.MacroCategorias || row.MacroCategoria || row.MacroFricciones || '');
    topics.forEach(t => {
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    });
  });
  const total = scoped.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([topic, n]) => ({ topic, n, pct: pct(n, total) }));
}
