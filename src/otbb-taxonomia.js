// src/otbb-taxonomia.js
// Lógica pura de la taxonomía OTBB: valores cerrados de flujo, derivación
// determinística desde la metadata del hilo y agregación de la categoría
// principal de la conversación. Sin dependencias de React ni del DOM para que
// scripts/test-otbb-taxonomia.mjs pueda importarlo desde Node.

export const ORIGEN_INBOUND = 'Inbound';
export const ORIGEN_OUTBOUND = 'Outbound';
export const ORIGEN_VALUES = [ORIGEN_INBOUND, ORIGEN_OUTBOUND];

export const APERTURA_NO_APLICA = 'No Aplica';
export const APERTURA_SIN_RESPUESTA = 'El cliente nunca respondió al correo del banco';
export const APERTURA_VALUES = [
  'Persecución de demanda',
  'Campañas de marketing',
  'Cuerpo vacío / solo adjuntos',
  'Inbound frío (conversación nueva)',
  'Inbound continuación de conversación previa',
  APERTURA_SIN_RESPUESTA,
  APERTURA_NO_APLICA,
];

// El origen ya restringe qué aperturas son posibles: no tiene sentido ofrecerle
// al modelo "Campañas de marketing" en un hilo que abrió el cliente.
export const APERTURA_BY_ORIGEN = {
  [ORIGEN_INBOUND]: [
    'Inbound frío (conversación nueva)',
    'Inbound continuación de conversación previa',
    APERTURA_NO_APLICA,
  ],
  [ORIGEN_OUTBOUND]: [
    'Persecución de demanda',
    'Campañas de marketing',
    'Cuerpo vacío / solo adjuntos',
    APERTURA_SIN_RESPUESTA,
    APERTURA_NO_APLICA,
  ],
};

export const GESTION_HUERFANA = 'Cliente escribió y nadie respondió (huérfana)';
export const GESTION_SIN_GESTION = 'Sin gestión (unilateral del banco)';

// Los ocho valores de la base más el derivado para hilos donde el cliente nunca
// apareció: la base los cubre desde Tipo Apertura, pero Gestión necesita un
// bucket propio para que las compuertas sumen el total.
export const GESTION_MAP = {
  'Conversación neta (el cliente participa)': { neta: true, casoActivo: false, caida: null },
  'Caso comercial activo (entra a gestión documental)': { neta: true, casoActivo: true, caida: null },
  [GESTION_HUERFANA]: { neta: false, casoActivo: false, caida: 'apertura' },
  'Intercambio tibio, murió sin abrir caso': { neta: true, casoActivo: false, caida: 'apertura' },
  'Cotizó y nadie activó el paso siguiente': { neta: true, casoActivo: true, caida: 'documental' },
  'Caso abierto que se apagó sin entrega': { neta: true, casoActivo: true, caida: 'documental' },
  'Entregó documentos y nadie respondió jamás': { neta: true, casoActivo: true, caida: 'documental' },
  'Le pidieron un faltante y no volvió': { neta: true, casoActivo: true, caida: 'documental' },
  [GESTION_SIN_GESTION]: { neta: false, casoActivo: false, caida: null },
};

export const GESTION_VALUES = Object.keys(GESTION_MAP);

// Valores que el modelo puede elegir: los dos deterministas quedan fuera porque
// se resuelven desde la metadata del hilo.
export const GESTION_LLM_VALUES = GESTION_VALUES.filter(
  value => value !== GESTION_HUERFANA && value !== GESTION_SIN_GESTION
);

export const DESENLACE_DERIVACION = 'Derivación u otro producto';

// "Los rechazos y las declinaciones no cuentan como caída, y las inciertas son
// invisibilidad, no abandono". Por eso decidido e invisible viven separados.
export const DESENLACE_BUCKETS = {
  'Colocación verificada (curse, incluye bypass por otro canal)': 'ganado',
  'Aprobado, firma en tránsito': 'ganado',
  'En gestión con señal de avance': 'vivo',
  'Rechazada por riesgo': 'decidido',
  'Cliente declina o continúa por otro canal': 'decidido',
  [DESENLACE_DERIVACION]: 'fuera',
  'Entregó documentación; sin desenlace visible': 'invisible',
  'En teléfono o evaluación; sin desenlace visible': 'invisible',
};

export const DESENLACE_VALUES = Object.keys(DESENLACE_BUCKETS);

export const BUCKET_LABELS = {
  ganado: 'Ganado',
  vivo: 'Vivo al corte',
  decidido: 'Decidido sin venta',
  invisible: 'Sin desenlace visible',
  fuera: 'Fuera del análisis',
};

export const CAIDA_LABELS = {
  apertura: 'Caída de apertura',
  documental: 'Caída de gestión documental',
};

export const CONFIDENCE_FLOOR = 0.5;

// Códigos que no representan un tema de negocio y no pueden ganar la agregación.
export const FILLER_CODES = ['WMA000', 'VACÍO', 'VACIO', 'ERROR'];

export function normalizeClosed(value, allowed, fallback) {
  const text = String(value ?? '').trim();
  return allowed.includes(text) ? text : fallback;
}

// La fuente escribe "Outbond"; el archivo se conserva literal y la corrección
// vive acá, en la capa de lectura.
export function normalizeOrigen(value) {
  const text = String(value ?? '').trim();
  if (/^outbo/i.test(text)) return ORIGEN_OUTBOUND;
  if (/^inbo/i.test(text)) return ORIGEN_INBOUND;
  return '';
}

export function composicionOf(row = {}) {
  return String(row.composicion_hilo || row.tipo_hilo || '').trim().toLowerCase();
}

// Origen sale de metadata (quién mandó el primer correo), nunca del modelo.
export function origenFromRow(row = {}) {
  const iniciado = String(row.iniciado_por || '').trim().toLowerCase();
  if (iniciado === 'cliente') return ORIGEN_INBOUND;
  if (iniciado === 'ejecutivo') return ORIGEN_OUTBOUND;
  return '';
}

// Solo un hilo con ambos lados es "conversación neta". 'interno' cuenta como no
// neta: son correos entre ejecutivos, el cliente nunca estuvo.
export function esNetaDeterministica(row = {}) {
  return composicionOf(row) === 'mixto';
}

// Cuando el hilo es unilateral la Gestión no se le pregunta al modelo, y si el
// modelo la devuelve igual, gana la metadata.
export function resolveGestion(llmValue, row = {}) {
  const composicion = composicionOf(row);
  if (composicion === 'inbound') return GESTION_HUERFANA;
  if (composicion === 'outbound' || composicion === 'interno') return GESTION_SIN_GESTION;
  return normalizeClosed(llmValue, GESTION_LLM_VALUES, 'Intercambio tibio, murió sin abrir caso');
}

export function resolveApertura(llmValue, origen, row = {}) {
  if (composicionOf(row) === 'outbound') return APERTURA_SIN_RESPUESTA;
  const allowed = APERTURA_BY_ORIGEN[origen] || APERTURA_VALUES;
  return normalizeClosed(llmValue, allowed, APERTURA_NO_APLICA);
}

export function desenlaceBucket(desenlace) {
  return DESENLACE_BUCKETS[String(desenlace ?? '').trim()] || 'invisible';
}

/**
 * Estado de flujo de una conversación, con las compuertas ya reconciliadas
 * contra la metadata. Garantiza base >= neta >= casoActivo >= desenlaceVisible.
 */
export function conversationFlowState(row = {}) {
  const origen = normalizeOrigen(row.Origen) || origenFromRow(row);
  const gestion = resolveGestion(row.Gestion, row);
  const apertura = resolveApertura(row.Apertura, origen, row);
  const desenlace = normalizeClosed(row.Desenlace, DESENLACE_VALUES, '');
  const bucket = desenlace ? desenlaceBucket(desenlace) : 'invisible';
  const map = GESTION_MAP[gestion] || GESTION_MAP[GESTION_SIN_GESTION];

  // La metadata manda: si el hilo no es bilateral no hay caso comercial por
  // mucho que el modelo lo afirme.
  const neta = map.neta && esNetaDeterministica(row);
  const casoActivo = neta && map.casoActivo;
  const enBase = bucket !== 'fuera';

  return {
    origen,
    apertura,
    gestion,
    desenlace,
    bucket,
    caida: map.caida,
    enBase,
    neta: enBase && neta,
    casoActivo: enBase && casoActivo,
    desenlaceVisible: enBase && casoActivo && bucket !== 'invisible',
  };
}

export const FUNNEL_GATES = [
  { key: 'base', label: 'Base analizable' },
  { key: 'neta', label: 'Conversación neta' },
  { key: 'casoActivo', label: 'Caso comercial activo' },
  { key: 'desenlaceVisible', label: 'Desenlace visible' },
];

/**
 * Funnel acumulativo. Los porcentajes giran en torno a la base, no al paso
 * anterior, y las derivadas quedan fuera del denominador.
 */
export function funnelGates(rows = []) {
  const states = rows.map(conversationFlowState);
  const inBase = states.filter(s => s.enBase);
  const base = inBase.length;
  const counts = {
    base,
    neta: inBase.filter(s => s.neta).length,
    casoActivo: inBase.filter(s => s.casoActivo).length,
    desenlaceVisible: inBase.filter(s => s.desenlaceVisible).length,
  };
  return FUNNEL_GATES.map(gate => ({
    ...gate,
    n: counts[gate.key],
    pct: base ? (counts[gate.key] / base) * 100 : 0,
  }));
}

/** Distribución de desenlaces sobre la base analizable; las derivadas aparte. */
export function desenlaceDistribution(rows = []) {
  const states = rows.map(conversationFlowState);
  const fuera = states.filter(s => !s.enBase).length;
  const inBase = states.filter(s => s.enBase);
  const counts = new Map();
  inBase.forEach(s => {
    const key = s.desenlace || 'Sin clasificar';
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const buckets = new Map();
  inBase.forEach(s => buckets.set(s.bucket, (buckets.get(s.bucket) || 0) + 1));
  return {
    base: inBase.length,
    fuera,
    porDesenlace: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]),
    porBucket: Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]),
  };
}

// ─── Trazabilidad hacia el catálogo de flujo ─────────────────────────────────
// Las compuertas y los buckets renombran o agrupan valores del catálogo, así
// que sin esto el tablero muestra números que no se pueden devolver a su origen.
// Todo se deriva de los mapas de arriba: no hay una segunda lista que mantener.

function gestionValuesWhere(predicate) {
  return GESTION_VALUES.filter(value => predicate(GESTION_MAP[value]));
}

/** Valores del catálogo de Desenlace que caen en un bucket. */
export function desenlaceValuesForBucket(bucket) {
  return DESENLACE_VALUES.filter(value => DESENLACE_BUCKETS[value] === bucket);
}

/** Valores del catálogo de Gestión que producen un tipo de caída. */
export function gestionValuesForCaida(caida) {
  return gestionValuesWhere(map => map.caida === caida);
}

/**
 * De dónde sale cada compuerta: el campo del catálogo que la origina, los
 * valores que caen dentro y si el nombre es del catálogo o un límite que
 * calcula el tablero. Base y desenlace visible son calculados: no existen como
 * valor en ninguna de las cuatro dimensiones.
 */
export const GATE_LINEAGE = {
  base: {
    campo: 'Desenlace',
    derivado: true,
    nota: `Calculado: todas las conversaciones menos las de "${DESENLACE_DERIVACION}".`,
    valores: DESENLACE_VALUES.filter(value => DESENLACE_BUCKETS[value] !== 'fuera'),
  },
  neta: {
    campo: 'Gestion',
    derivado: false,
    nota: 'Valor del catálogo de Gestión. Estos valores cuentan dentro:',
    valores: gestionValuesWhere(map => map.neta),
  },
  casoActivo: {
    campo: 'Gestion',
    derivado: false,
    nota: 'Valor del catálogo de Gestión. Estos valores cuentan dentro, incluidos los que terminan en caída:',
    valores: gestionValuesWhere(map => map.casoActivo),
  },
  desenlaceVisible: {
    campo: 'Desenlace',
    derivado: true,
    nota: 'Calculado: caso comercial activo cuyo desenlace no es de los "sin desenlace visible". Visible es observable, no resuelto.',
    valores: DESENLACE_VALUES.filter(
      value => !['fuera', 'invisible'].includes(DESENLACE_BUCKETS[value])
    ),
  },
};

/**
 * Aplana el catálogo de flujo servido por /api/catalog/flujo a lo único que el
 * tablero necesita: la definición de cada campo y de cada valor. El resto
 * (enums, prompts) ya vive en los mapas o solo le sirve al modelo.
 */
export function flowDefinitionIndex(flowData) {
  const campos = {};
  const valores = {};
  (flowData?.fields || []).forEach(field => {
    if (field.definicion) campos[field.key] = field.definicion;
    (field.valores || []).forEach(({ valor, definicion }) => {
      if (valor && definicion) valores[valor] = definicion;
    });
  });
  return { campos, valores };
}

/** Caídas por tipo sobre la base analizable. */
export function caidaDistribution(rows = []) {
  const states = rows.map(conversationFlowState).filter(s => s.enBase);
  const counts = new Map();
  states.forEach(s => {
    if (!s.caida) return;
    counts.set(s.gestion, (counts.get(s.gestion) || 0) + 1);
  });
  return {
    base: states.length,
    apertura: states.filter(s => s.caida === 'apertura').length,
    documental: states.filter(s => s.caida === 'documental').length,
    porGestion: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]),
  };
}

/**
 * Categoría principal de la conversación a partir de las etiquetas por turno.
 * Gana el código con mayor confianza acumulada, no el turno más confiado: un
 * "adjunto mi cédula" con 0.98 no debe tapar el tema real repetido a 0.74.
 */
export function aggregatePrincipalCategory(turnos = []) {
  const substantive = new Map();
  const filler = new Map();

  turnos.forEach((turno, idx) => {
    const code = String(turno?.code ?? '').trim();
    if (!code) return;
    const confidence = Number(turno?.confidence);
    const safeConfidence = Number.isFinite(confidence) ? confidence : 0;
    const orden = Number(turno?.n) > 0 ? Number(turno.n) : idx + 1;
    const isFiller = FILLER_CODES.includes(code);
    // El piso evita que la repetición le gane a la certeza: diez turnos a 0.3
    // no deben desplazar a uno a 0.95.
    if (!isFiller && safeConfidence < CONFIDENCE_FLOOR) return;
    const target = isFiller ? filler : substantive;
    const prev = target.get(code);
    if (prev) {
      prev.score += safeConfidence;
      prev.maxConfidence = Math.max(prev.maxConfidence, safeConfidence);
      prev.firstTurn = Math.min(prev.firstTurn, orden);
      prev.count += 1;
    } else {
      target.set(code, { code, score: safeConfidence, maxConfidence: safeConfidence, firstTurn: orden, count: 1 });
    }
  });

  // Orden total explícito: sin el desempate el resultado cambia entre corridas
  // sobre la misma data.
  const byScore = (a, b) => b.score - a.score || a.firstTurn - b.firstTurn || a.code.localeCompare(b.code);
  const ranked = Array.from(substantive.values()).sort(byScore);
  const winner = ranked[0] || Array.from(filler.values()).sort(byScore)[0];

  if (!winner) {
    return { code: 'WMA000', confidence: 0, score: 0, count: 0, secondary: [] };
  }

  return {
    code: winner.code,
    // La UI pinta este campo como porcentaje: va el máximo del código ganador,
    // no el acumulado, que puede pasar de 1.
    confidence: winner.maxConfidence,
    score: winner.score,
    count: winner.count,
    secondary: ranked.filter(item => item.code !== winner.code).map(item => item.code),
  };
}
