import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APERTURA_SIN_RESPUESTA,
  BUCKET_LABELS,
  CONFIDENCE_FLOOR,
  DESENLACE_BUCKETS,
  DESENLACE_VALUES,
  GATE_LINEAGE,
  GESTION_HUERFANA,
  GESTION_MAP,
  GESTION_SIN_GESTION,
  aggregatePrincipalCategory,
  conversationFlowState,
  desenlaceDistribution,
  desenlaceValuesForBucket,
  flowDefinitionIndex,
  funnelGates,
  gestionValuesForCaida,
  normalizeOrigen,
  resolveApertura,
  resolveGestion,
} from '../src/otbb-taxonomia.js';
import {
  SIN_PRODUCTO,
  applyZoom,
  criticalThreads,
  getFlowAnalytics,
  getThreadAnalytics,
  intensityHeatmap,
  finalizeThreadAnnotations,
  observedOrigenByCode,
  openThreadsByStage,
  resolveFrictionTurn,
  stageFunnel,
  zoomOptions,
} from '../src/otbb-analytics.js';
import { getBancaMaster, getFlowDefinitions, getFrictionCatalog, stripReportingFigures } from '../catalog-service.js';
import { normalizeAnthropicBody, normalizeOpenAiChatBody } from '../llm-request.js';
import {
  buildThreadRows,
  inferInternalColumn,
  parseInternalFlag,
} from '../src/threading.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const flowRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'Definiciones_flujo.json'), 'utf8'));
const frictionRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'Definiciones_fricciones.json'), 'utf8'));

// ── 1. Los mapas no se desalinean del JSON ───────────────────────────────────
// Si alguien edita la base, este assert falla antes de que el modelo empiece a
// devolver valores que el código descarta en silencio.
const gestionEnJson = flowRaw.indices.por_campo['Gestión'];
gestionEnJson.forEach(value => {
  assert.ok(GESTION_MAP[value], `Gestión "${value}" está en la base pero no en GESTION_MAP`);
});
Object.keys(GESTION_MAP).forEach(value => {
  if (value === GESTION_SIN_GESTION) return; // derivado, no existe en la base
  assert.ok(gestionEnJson.includes(value), `GESTION_MAP tiene "${value}" que ya no está en la base`);
});

const desenlaceEnJson = flowRaw.indices.por_campo['Desenlace'];
assert.deepEqual([...DESENLACE_VALUES].sort(), [...desenlaceEnJson].sort(), 'DESENLACE_BUCKETS desalineado de la base');

// ── 2. Catálogo de fricciones completo ───────────────────────────────────────
const frictions = getFrictionCatalog();
assert.equal(frictions.fricciones.length, frictionRaw.metadata.totales.fricciones);
assert.equal(frictions.macros.length, frictionRaw.metadata.totales.macro_fricciones);
const macroIds = new Set(frictions.macros.map(m => m.id));
frictions.fricciones.forEach(f => {
  assert.ok(macroIds.has(f.macroId), `${f.id} apunta a una macro-fricción inexistente: ${f.macroId}`);
});
assert.ok(frictions.prompt.includes('FR-RC-01'), 'el prompt de fricciones no lista los ids');
assert.ok(frictions.prompt.includes('"necesito hoy"'), 'los términos literales no llegan al prompt');

// ── 3. Limpieza de cifras de reportería ──────────────────────────────────────
assert.equal(
  stripReportingFigures('Es el denominador de la apertura (40% de la base del mes). Ambos lados hablaron.'),
  'Ambos lados hablaron.'
);
assert.equal(
  stripReportingFigures('Uno de cada dos avanza a caso comercial. El cliente escribe primero.'),
  'El cliente escribe primero.'
);
const flow = getFlowDefinitions();
const flowText = JSON.stringify(flow);
assert.ok(!/\d+\s*%/.test(flowText), 'quedaron porcentajes de reportería en las definiciones de flujo');
// El paréntesis del nombre del valor no es una cifra y debe sobrevivir.
assert.ok(flow.enums.Gestion.includes('Conversación neta (el cliente participa)'));
assert.deepEqual(flow.enums.Origen, ['Inbound', 'Outbound'], 'el typo Outbond no se normalizó');
assert.equal(normalizeOrigen('Outbond'), 'Outbound');

// ── 4. La metadata manda sobre el modelo ─────────────────────────────────────
const hiloSoloCliente = { composicion_hilo: 'inbound', iniciado_por: 'cliente' };
const hiloSoloBanco = { composicion_hilo: 'outbound', iniciado_por: 'ejecutivo' };
assert.equal(resolveGestion('Caso comercial activo (entra a gestión documental)', hiloSoloCliente), GESTION_HUERFANA);
assert.equal(resolveGestion('Caso comercial activo (entra a gestión documental)', hiloSoloBanco), GESTION_SIN_GESTION);
assert.equal(resolveApertura('Campañas de marketing', 'Outbound', hiloSoloBanco), APERTURA_SIN_RESPUESTA);
// Un valor inventado por el modelo no puede colarse.
assert.equal(resolveGestion('Se murió la conversación', { composicion_hilo: 'mixto' }), 'Intercambio tibio, murió sin abrir caso');

// ── 5. Monotonía del funnel ──────────────────────────────────────────────────
const rows = [
  // Contradice al modelo: dice caso activo pero el hilo es unilateral.
  { composicion_hilo: 'inbound', iniciado_por: 'cliente', Gestion: 'Caso comercial activo (entra a gestión documental)', Desenlace: 'Entregó documentación; sin desenlace visible' },
  { composicion_hilo: 'mixto', iniciado_por: 'cliente', Gestion: 'Entregó documentos y nadie respondió jamás', Desenlace: 'Entregó documentación; sin desenlace visible' },
  { composicion_hilo: 'mixto', iniciado_por: 'ejecutivo', Gestion: 'Caso comercial activo (entra a gestión documental)', Desenlace: 'Colocación verificada (curse, incluye bypass por otro canal)' },
  { composicion_hilo: 'mixto', iniciado_por: 'cliente', Gestion: 'Intercambio tibio, murió sin abrir caso', Desenlace: 'Cliente declina o continúa por otro canal' },
  { composicion_hilo: 'outbound', iniciado_por: 'ejecutivo', Gestion: '', Desenlace: 'En teléfono o evaluación; sin desenlace visible' },
  // Derivada: fuera del denominador.
  { composicion_hilo: 'mixto', iniciado_por: 'cliente', Gestion: 'Caso comercial activo (entra a gestión documental)', Desenlace: 'Derivación u otro producto' },
];

const contradictoria = conversationFlowState(rows[0]);
assert.equal(contradictoria.casoActivo, false, 'un hilo unilateral no puede ser caso comercial activo');
assert.equal(contradictoria.neta, false);

const gates = funnelGates(rows);
assert.deepEqual(gates.map(g => g.key), ['base', 'neta', 'casoActivo', 'desenlaceVisible']);
for (let i = 1; i < gates.length; i++) {
  assert.ok(gates[i].n <= gates[i - 1].n, `el funnel no es monótono en "${gates[i].label}"`);
}
assert.equal(gates[0].n, 5, 'la derivada debe quedar fuera de la base analizable');
assert.equal(gates[1].n, 3);
assert.equal(gates[2].n, 2);
assert.equal(gates[3].n, 1, 'solo la colocación tiene desenlace visible sobre un caso activo');

// ── 6. Los buckets cierran la base ───────────────────────────────────────────
const dist = desenlaceDistribution(rows);
assert.equal(dist.fuera, 1);
assert.equal(dist.base, 5);
assert.equal(dist.porBucket.reduce((sum, [, n]) => sum + n, 0), dist.base, 'los buckets no suman la base analizable');
assert.ok(!dist.porBucket.some(([bucket]) => bucket === 'fuera'), 'las derivadas no pueden estar dentro de los buckets');
// Rechazo y declinación son decisión, no caída ni invisibilidad.
assert.equal(DESENLACE_BUCKETS['Rechazada por riesgo'], 'decidido');
assert.equal(DESENLACE_BUCKETS['Cliente declina o continúa por otro canal'], 'decidido');

// ── 7. Agregación de la categoría principal ──────────────────────────────────
// El tema real repetido con confianza media le gana al trámite muy confiado.
const repetido = aggregatePrincipalCategory([
  { n: 1, code: 'WMA010', confidence: 0.74 },
  { n: 2, code: 'WMA010', confidence: 0.74 },
  { n: 3, code: 'WMA010', confidence: 0.74 },
  { n: 4, code: 'WMA010', confidence: 0.74 },
  { n: 5, code: 'WMA010', confidence: 0.74 },
  { n: 6, code: 'WMA010', confidence: 0.74 },
  { n: 7, code: 'WMA002', confidence: 0.98 },
]);
assert.equal(repetido.code, 'WMA010');
assert.equal(repetido.confidence, 0.74, 'Confianza debe ser el máximo del ganador, no el acumulado');
assert.ok(repetido.confidence <= 1, 'Confianza sobre 1 rompe la barra de porcentaje de la UI');
assert.deepEqual(repetido.secondary, ['WMA002']);

// El piso impide que el ruido repetido desplace a la certeza.
const ruido = aggregatePrincipalCategory([
  ...Array.from({ length: 10 }, (_, i) => ({ n: i + 1, code: 'WMA003', confidence: 0.3 })),
  { n: 11, code: 'WMA004', confidence: 0.95 },
]);
assert.equal(ruido.code, 'WMA004');
assert.ok(CONFIDENCE_FLOOR > 0.3 && CONFIDENCE_FLOOR <= 0.95);

// Empate exacto: gana el turno más antiguo, y el resultado es reproducible.
const empate = aggregatePrincipalCategory([
  { n: 5, code: 'WMA020', confidence: 0.9 },
  { n: 2, code: 'WMA021', confidence: 0.9 },
]);
assert.equal(empate.code, 'WMA021');
assert.equal(
  aggregatePrincipalCategory([
    { n: 2, code: 'WMA021', confidence: 0.9 },
    { n: 5, code: 'WMA020', confidence: 0.9 },
  ]).code,
  'WMA021',
  'el orden de llegada del JSON no puede cambiar el resultado'
);

// El relleno solo gana si no hay nada sustantivo, y nunca queda vacío.
assert.equal(aggregatePrincipalCategory([
  { n: 1, code: 'WMA000', confidence: 0.99 },
  { n: 2, code: 'WMA000', confidence: 0.99 },
  { n: 3, code: 'WMA007', confidence: 0.6 },
]).code, 'WMA007');
assert.equal(aggregatePrincipalCategory([{ n: 1, code: 'WMA000', confidence: 0 }]).code, 'WMA000');
assert.equal(aggregatePrincipalCategory([]).code, 'WMA000');

// ── 8. Analítica del dashboard: nada se pierde en el camino ──────────────────
// Filas de hilo como las que produce el pipeline: journey y llave de negocio ya
// resueltos desde el catálogo, fricciones como lista separada por ";".
const hilos = [
  { thread_id: 'T1', SegmentoNegocio: 'Pyme', ProductoNegocio: 'Crédito Pyme', JourneyConversacional: 'Venta / Originación',
    composicion_hilo: 'mixto', iniciado_por: 'cliente', Gestion: 'Caso comercial activo (entra a gestión documental)',
    Desenlace: 'Colocación verificada (curse, incluye bypass por otro canal)', Fricciones: '', silencio_maximo_horas: 4 },
  { thread_id: 'T2', SegmentoNegocio: 'Pyme', ProductoNegocio: 'Crédito Pyme', JourneyConversacional: 'Postventa / Gestión',
    composicion_hilo: 'mixto', iniciado_por: 'cliente', Gestion: 'Entregó documentos y nadie respondió jamás',
    Desenlace: 'Entregó documentación; sin desenlace visible', Fricciones: 'FR-EC-02; FR-CC-01',
    FriccionesNombres: 'Silencio operativo; Información ya entregada', silencio_maximo_horas: 720 },
  { thread_id: 'T3', SegmentoNegocio: 'Pyme', ProductoNegocio: 'Leasing Pyme', JourneyConversacional: 'Cobranza',
    composicion_hilo: 'mixto', iniciado_por: 'ejecutivo', Gestion: 'Caso comercial activo (entra a gestión documental)',
    Desenlace: 'En gestión con señal de avance', Fricciones: 'FR-EC-02; FR-CC-01; FR-PL-01',
    FriccionesNombres: 'Silencio operativo; Información ya entregada; Información contradictoria', silencio_maximo_horas: 48 },
  { thread_id: 'T4', SegmentoNegocio: 'Retail / Personas', ProductoNegocio: 'Tarjeta de Crédito', JourneyConversacional: 'Activación',
    composicion_hilo: 'inbound', iniciado_por: 'cliente', Desenlace: 'En teléfono o evaluación; sin desenlace visible',
    Fricciones: 'FR-EC-02', FriccionesNombres: 'Silencio operativo', silencio_maximo_horas: 96 },
  // Sin metadata de negocio: no puede desaparecer del tablero.
  { thread_id: 'T5', JourneyConversacional: 'Sin journey', composicion_hilo: 'mixto', iniciado_por: 'cliente',
    Gestion: 'Intercambio tibio, murió sin abrir caso', Desenlace: 'Rechazada por riesgo', Fricciones: '' },
];

// El embudo por etapa es una partición: cada hilo vive en exactamente una etapa.
const etapas = stageFunnel(hilos);
assert.equal(etapas.reduce((sum, s) => sum + s.n, 0), hilos.length, 'el embudo por etapa no suma el total de hilos');
assert.deepEqual(
  etapas.map(s => s.stage),
  ['Venta / Originación', 'Activación', 'Postventa / Gestión', 'Cobranza', 'Sin journey'],
  'las etapas van en el orden canónico del journey, con las desconocidas al final'
);
// La caída se mide dentro de la etapa, nunca contra la etapa siguiente.
const postventa = etapas.find(s => s.stage === 'Postventa / Gestión');
assert.equal(postventa.casoActivo, 1);
assert.equal(postventa.desenlaceVisible, 0, 'entregó documentación sin desenlace no es desenlace visible');
assert.equal(postventa.apagados, 1);

// Abiertos = vivo + sin desenlace visible, y la distribución suma ese conteo.
const abiertos = openThreadsByStage(hilos);
assert.equal(abiertos.total, 3, 'T2, T3 y T4 son los únicos hilos abiertos');
assert.equal(abiertos.stages.reduce((sum, s) => sum + s.n, 0), abiertos.total, 'los abiertos no cierran su propia base');
assert.ok(abiertos.stages.every(s => s.n > 0), 'no deben aparecer etapas sin hilos abiertos');

// Cada fila del heatmap reparte el 100% de los hilos de su etapa.
const heatmap = intensityHeatmap(hilos);
assert.equal(heatmap.reduce((sum, r) => sum + r.n, 0), hilos.length);
heatmap.forEach(row => {
  assert.equal(row.levels.reduce((sum, l) => sum + l.n, 0), row.n, `la fila "${row.stage}" pierde hilos`);
  assert.ok(Math.abs(row.levels.reduce((sum, l) => sum + l.pct, 0) - 100) < 0.5, `la fila "${row.stage}" no suma 100%`);
});
assert.equal(heatmap.find(r => r.stage === 'Cobranza').levels.find(l => l.key === 'alta').n, 1, 'tres fricciones es intensidad alta');
assert.equal(heatmap.find(r => r.stage === 'Postventa / Gestión').levels.find(l => l.key === 'media').n, 1);

// WMC no es una etapa del journey: vive en cobertura de exclusiones, no aquí.
const conExclusion = [
  ...hilos,
  {
    thread_id: 'T6',
    CategoriaAsignada: 'WMC001',
    JourneyConversacional: 'Exclusión',
    composicion_hilo: 'mixto',
    iniciado_por: 'cliente',
    Gestion: 'Intercambio tibio, murió sin abrir caso',
    Desenlace: 'No aplica',
  },
];
assert.ok(!stageFunnel(conExclusion).some(s => s.stage === 'Exclusión'));
assert.equal(stageFunnel(conExclusion).reduce((sum, s) => sum + s.n, 0), hilos.length);
assert.ok(!intensityHeatmap(conExclusion).some(s => s.stage === 'Exclusión'));
assert.ok(!openThreadsByStage(conExclusion).stages.some(s => s.stage === 'Exclusión'));
assert.ok(!getFlowAnalytics(conExclusion).journeys.some(j => j.journey === 'Exclusión'));
assert.equal(applyZoom(conExclusion, { etapa: 'Venta / Originación' }).every(row => row.thread_id !== 'T6'), true);

// La partición por producto es exhaustiva: si el filtro pierde filas en
// silencio, este assert es el que lo caza.
const opciones = zoomOptions(hilos);
assert.equal(
  opciones.reduce((sum, s) => sum + s.n, 0),
  hilos.length,
  'las opciones de zoom no cubren todos los hilos'
);
assert.ok(
  opciones.some(s => s.products.some(p => p.product === SIN_PRODUCTO)),
  'los hilos sin metadata de negocio deben quedar en un bucket visible, no descartados'
);
opciones.forEach(segment => {
  const porProducto = segment.products.reduce((sum, p) => sum + p.n, 0);
  assert.equal(porProducto, segment.n, `el segmento "${segment.segment}" pierde hilos al abrir por producto`);
  assert.equal(applyZoom(hilos, { segmento: segment.segment }).length, segment.n);
  segment.products.forEach(p => {
    assert.equal(applyZoom(hilos, { segmento: segment.segment, producto: p.product }).length, p.n);
  });
});
assert.equal(applyZoom(hilos, { etapa: 'Cobranza' }).length, 1);

// El ranking de fricciones cruza contra el catálogo: si un id deja de existir,
// la columna de señal detectable queda muda sin avisar.
const stats = getThreadAnalytics(hilos);
assert.equal(stats.topFrictions[0].id, 'FR-EC-02', 'la fricción más repetida debe encabezar el ranking');
assert.equal(stats.topFrictions[0].n, 3);
assert.equal(stats.insistencia, 3, 'insistencia se cuenta por hilo, no por aparición');
stats.topFrictions.forEach(f => {
  assert.ok(frictions.byId[f.id], `la fricción ${f.id} no existe en el catálogo`);
  assert.ok(frictions.byId[f.id].senal, `${f.id} no tiene señal detectable para mostrar`);
});
assert.equal(stats.cerrados, 2, 'colocación y rechazo son cierres; el resto sigue en juego');

// Críticas: abierto + caso activo, ordenadas por silencio.
const criticas = criticalThreads(hilos);
assert.ok(criticas.items.length > 0);
assert.equal(criticas.items[0].id, 'T2', 'el hilo con más silencio va primero');
assert.equal(criticas.items[0].days, 30);
assert.ok(!criticas.items.some(item => item.id === 'T4'), 'un hilo huérfano no tiene caso comercial activo');
assert.ok(!criticas.items.some(item => item.id === 'T1'), 'un hilo ya ganado no es crítico');

// ── Trazabilidad hacia el catálogo ───────────────────────────────────────────
// El tablero renombra y agrupa; estas aserciones garantizan que el camino de
// vuelta al catálogo siga existiendo y no deje valores huérfanos ni repetidos.
// Un bucket sin etiqueta se dibuja con su clave interna ("invisible") en la
// tarjeta, que es justo la fuga de vocabulario que este cambio viene a cerrar.
const buckets = [...new Set(Object.values(DESENLACE_BUCKETS))];
buckets.forEach(bucket => {
  assert.ok(BUCKET_LABELS[bucket], `el bucket "${bucket}" no tiene etiqueta legible`);
  assert.ok(
    desenlaceValuesForBucket(bucket).length > 0,
    `el bucket "${bucket}" no declara ningún valor del catálogo`
  );
});

// Las compuertas están anidadas: lo que entra a una entra a la anterior.
assert.ok(
  GATE_LINEAGE.casoActivo.valores.every(v => GATE_LINEAGE.neta.valores.includes(v)),
  'hay un caso comercial activo que no cuenta como conversación neta'
);
assert.ok(
  GATE_LINEAGE.casoActivo.valores.length < GATE_LINEAGE.neta.valores.length,
  'caso activo debe ser estrictamente más chico que neta'
);
// Las cuatro compuertas del funnel tienen linaje: si alguien agrega una quinta
// y olvida declararlo, la tarjeta queda sin origen y el tooltip vacío.
funnelGates([]).forEach(gate => {
  const lineage = GATE_LINEAGE[gate.key];
  assert.ok(lineage, `la compuerta ${gate.key} no declara su origen en el catálogo`);
  assert.ok(lineage.valores.length > 0, `la compuerta ${gate.key} no declara ningún valor`);
  assert.ok(lineage.nota, `la compuerta ${gate.key} no explica cómo se compone`);
});

// Las caídas salen de Gestión y no se pisan entre sí.
const apertura = gestionValuesForCaida('apertura');
const documental = gestionValuesForCaida('documental');
assert.ok(apertura.length > 0 && documental.length > 0, 'faltan valores para alguna caída');
assert.equal(
  apertura.filter(v => documental.includes(v)).length,
  0,
  'un valor de Gestión no puede ser caída de apertura y documental a la vez'
);

// Las definiciones que el tablero muestra existen para todo lo que renderiza.
const defs = flowDefinitionIndex(getFlowDefinitions());
[...DESENLACE_VALUES, ...gestionEnJson].forEach(valor => {
  assert.ok(defs.valores[valor], `"${valor}" no tiene definición para el tooltip del tablero`);
});
// El campo que declara cada compuerta debe resolver en el índice: un typo acá
// ("Gestión" con tilde en vez de "Gestion") deja el tooltip mudo sin romper nada.
Object.entries(GATE_LINEAGE).forEach(([key, lineage]) => {
  assert.ok(defs.campos[lineage.campo], `la compuerta ${key} apunta al campo inexistente "${lineage.campo}"`);
});

// El tablero de categorías lee `journey`, pero el catálogo de banca escribe
// `moduloJourney` (WMB emergente es el único que escribe `journey`). Si la cadena
// de alias se corta, todo el panel colapsa a "Sin journey".
const { metaMap: bancaMeta } = getBancaMaster();
const codigosBanca = Object.keys(bancaMeta);
assert.ok(codigosBanca.length > 0, 'el maestro de banca vino vacío');
const sinModulo = codigosBanca.filter(code => {
  const meta = bancaMeta[code];
  return !String(meta.journey || meta.moduloJourney || '').trim();
});
assert.equal(sinModulo.length, 0, `códigos del catálogo sin módulo del journey: ${sinModulo.slice(0, 5).join(', ')}`);

// La columna Origen del maestro resume un campo por conversación en una fila por
// tipificación: unánime va limpio, mezclado tiene que declarar el peso o miente.
const origenPorCodigo = observedOrigenByCode([
  { CategoriaAsignada: 'WMA001', Origen: 'Inbound' },
  { CategoriaAsignada: 'WMA001', Origen: 'Inbound' },
  { CategoriaAsignada: 'WMA002', Origen: 'Inbound' },
  { CategoriaAsignada: 'WMA002', Origen: 'Outbond' },
  { CategoriaAsignada: 'WMA002', Origen: 'Outbond' },
  { CategoriaAsignada: 'WMA003', Origen: '' },
  { CategoriaAsignada: '', Origen: 'Inbound' },
]);
assert.equal(origenPorCodigo.WMA001, 'Inbound', 'un origen unánime no debe traer porcentaje');
assert.equal(origenPorCodigo.WMA002, 'Outbond (66.7%)', 'un origen mezclado debe declarar el dominante y su peso');
assert.ok(!('WMA003' in origenPorCodigo), 'sin origen en la fila no se inventa un valor');
assert.ok(!('' in origenPorCodigo), 'una fila sin tipificación no genera entrada');

// Fricción anclada al hilo: n explícito gana; sin n se busca la evidencia;
// si no hay match no se inventa el turno 1.
assert.equal(resolveFrictionTurn({ n: 3, evidencia: 'x' }, 5, ['a', 'b', 'c', 'd', 'e']), 3);
assert.equal(resolveFrictionTurn({ evidencia: 'faltante' }, 5, ['hola', 'ok', 'pido el faltante', 'gracias', 'firma']), 3);
assert.equal(resolveFrictionTurn({ evidencia: 'no aparece' }, 5, ['a', 'b', 'c', 'd', 'e']), '');
assert.equal(resolveFrictionTurn({ n: 9, evidencia: '' }, 5, ['a', 'b', 'c', 'd', 'e']), '');

const frictionAnn = finalizeThreadAnnotations(
  [{
    thread_id: 'T1',
    n_interacciones: 5,
    __turnos: [
      { n: 1, code: 'WMA001', confidence: 0.9, evidence: [] },
      { n: 2, code: 'WMC004', confidence: 0.8, evidence: ['ok'] },
      { n: 3, code: 'WMA001', confidence: 0.7, evidence: ['faltante'] },
      { n: 4, code: 'WMA000', confidence: 0.4, evidence: [] },
      { n: 5, code: 'WMA000', confidence: 0.3, evidence: [] },
    ],
    __fricciones: [{ id: 'FR-EC-02', n: 3, evidencia: 'faltante' }],
  }],
  [1, 2, 3, 4, 5].map(n => ({
    thread_id: 'T1',
    orden_hilo: n,
    content_hilo: n === 3 ? 'pido el faltante' : `turno ${n}`,
  })),
  { WMC004: { tratamiento: 'Etiquetar – ignorable' } }
);
assert.equal(frictionAnn.taggedRows[0].FriccionIniciaEnHilo, 'FR-EC-02:3');
const marked = frictionAnn.detailRows.filter(row => row.friccion_inicia_aqui === 'Sí');
assert.equal(marked.length, 1, 'la fricción debe marcar un solo hilo');
assert.equal(marked[0].orden_hilo, 3);
assert.equal(marked[0].friccion_ids_en_este_hilo, 'FR-EC-02');
assert.equal(frictionAnn.detailRows[1].wmc_code, 'WMC004');
assert.equal(frictionAnn.detailRows[0].wmc_code, '');
assert.equal(frictionAnn.taggedRows[0].n_interacciones_wmc, 1);

const gpt41 = normalizeOpenAiChatBody({ model: 'gpt-4.1', max_tokens: 100, temperature: 0 });
assert.equal(gpt41.max_tokens, 100);
assert.equal(gpt41.temperature, 0);
assert.ok(!('max_completion_tokens' in gpt41));
const luna = normalizeOpenAiChatBody({ model: 'gpt-5.6-luna', max_tokens: 100, temperature: 0 });
assert.equal(luna.max_completion_tokens, 100);
assert.ok(!('max_tokens' in luna));
assert.ok(!('temperature' in luna));
const gpt52 = normalizeOpenAiChatBody({ model: 'gpt-5.2', max_tokens: 50, temperature: 0 });
assert.equal(gpt52.max_completion_tokens, 50);
assert.ok(!('max_tokens' in gpt52));

const sonnet46 = normalizeAnthropicBody({ model: 'claude-sonnet-4-6', max_tokens: 5000, temperature: 0, messages: [] });
assert.equal(sonnet46.temperature, 0);
assert.equal(sonnet46.max_tokens, 5000);
const sonnet5 = normalizeAnthropicBody({ model: 'claude-sonnet-5', max_tokens: 2000, temperature: 0, messages: [] });
assert.ok(!('temperature' in sonnet5));
assert.equal(sonnet5.max_tokens, 2000);
assert.equal(sonnet5.thinking?.type, 'disabled');
assert.ok(!('thinking' in sonnet46));

// ── 12. Flag interno y participación del hilo ────────────────────────────────
assert.equal(parseInternalFlag('True'), true);
assert.equal(parseInternalFlag('FALSE'), false);
assert.equal(parseInternalFlag('Interno'), true);
assert.equal(parseInternalFlag('Externo'), false);
assert.equal(parseInternalFlag(''), false);
assert.equal(inferInternalColumn(['Thread Id', 'Is Internal', 'Is Sent']), 'Is Internal');
assert.equal(inferInternalColumn(['Thread Id', 'Is Sent']), '');

const built = buildThreadRows([
  { 'Thread Id': 'A', 'Is Sent': 'False', 'Is Internal': 'True', Fecha: '2026-01-01', Body: 'hola colega' },
  { 'Thread Id': 'A', 'Is Sent': 'False', 'Is Internal': 'True', Fecha: '2026-01-02', Body: 'ok' },
  { 'Thread Id': 'B', 'Is Sent': 'False', 'Is Internal': 'False', Fecha: '2026-01-01', Body: 'cliente' },
  { 'Thread Id': 'C', 'Is Sent': 'False', 'Is Internal': 'True', Fecha: '2026-01-01', Body: 'interno' },
  { 'Thread Id': 'C', 'Is Sent': 'False', 'Is Internal': 'False', Fecha: '2026-01-02', Body: 'cliente' },
], {
  threadColumn: 'Thread Id',
  dateColumn: 'Fecha',
  contentColumn: 'Body',
  directionColumn: 'Is Sent',
  internalColumn: 'Is Internal',
});
assert.equal(built.threadRows.find(r => r.thread_id === 'A').participacion_hilo, 'interno');
assert.equal(built.threadRows.find(r => r.thread_id === 'B').participacion_hilo, 'externo');
assert.equal(built.threadRows.find(r => r.thread_id === 'C').participacion_hilo, 'mixto');
assert.equal(built.summary.internalMessagesTotal, 3);

console.log('OK: taxonomía OTBB, funnel, agregación de categoría principal, analítica y trazabilidad al catálogo');
