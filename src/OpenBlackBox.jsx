import { useState, useRef, useCallback, useEffect } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { API_BASE } from './config';
import { generateCatalogMappedMaster, generateEmergentCategories } from './invento';
import { buildThreadRows, inferThreadColumns, summarizeThreadRows } from './threading';
import { analyzeThreadSentiment } from './otbb-sentiment';
import { runExclusionMotor, summarizeExclusionCheckpoint } from './otbb-exclusiones';
import {
  APERTURA_BY_ORIGEN,
  BUCKET_LABELS,
  CAIDA_LABELS,
  DESENLACE_VALUES,
  GESTION_LLM_VALUES,
  aggregatePrincipalCategory,
  conversationFlowState,
  flowDefinitionIndex,
  normalizeClosed,
  origenFromRow,
  resolveApertura,
  resolveGestion,
} from './otbb-taxonomia';
import {
  SIN_JOURNEY,
  SIN_PRODUCTO,
  SIN_SEGMENTO,
  finalizeThreadAnnotations,
  getFlowAnalytics,
  isWmcCode,
  observedOrigenByCode,
  pct,
  round1,
} from './otbb-analytics';
import OtbbThreadDashboard from './otbb-dashboard';
import FileDropzone from './ui/FileDropzone';
import FilePreflight from './ui/FilePreflight';
import { MAX_DATOS_MB, estimarLlamadas } from './ui/archivos';
import OtbbReportConfig from './otbb-report-config';
import { createOtbbReportJob, pollOtbbReportPdf } from './otbb-report';

// ─── Constants ────────────────────────────────────────────────────────────────
const MODEL_OPTIONS = [
  { value: 'gpt-4.1', label: 'GPT-4.1 (rápido, menor costo)' },
  { value: 'gpt-5.2', label: 'GPT-5.2 (mayor precisión)' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6-luna (menos preciso, más barato)' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (experimental, más costoso)' },
];

const BATCH_SIZE   = 10;
const CONCURRENCY  = 4;
const THREAD_BATCH_SIZE = 5;
const THREAD_CONCURRENCY = 2;
const CLASSIFY_TIMEOUT_MS = 90000;
// v2: las filas v1 no tienen turnos ni campos de flujo, así que no son migrables.
const OTBB_STORAGE_KEY = 'otbb.cache.v2';

const WMB_INDUSTRIA_OPTIONS = ['Banca', 'Aseguradora', 'Retail', 'Otro'];
const WMB_ORIGEN_OPTIONS    = [
  { label: 'Email',  value: 'CORREO' },
  { label: 'RRSS',   value: 'RRSS'   },
  { label: 'Otro',   value: 'CORREO' }, // fallback al prompt más genérico
];

const THREAD_TAG_OPTIONS = [
  { label: '2 categorías', value: 2 },
  { label: '3 categorías', value: 3 },
  { label: '4 categorías', value: 4 },
  { label: 'Auto', value: 0 },
];

// ─── Lightweight Black Box Classifier ────────────────────────────────────────
// Prompt mínimo enriquecido: devuelve código, confianza, evidencia y justificación
// sin enumerar todas las categorías con value=0.

function buildCategoriesStr(masterJson) {
  return Object.entries(masterJson)
    .map(([code, name]) => `${code}: ${name}`)
    .join('\n');
}

function buildBBSystemPrompt(masterJson) {
  return `Eres un clasificador de mensajes de clientes de un banco.
Debes asignar a cada mensaje el código más apropiado de la siguiente lista.

### Categorías disponibles ###
${buildCategoriesStr(masterJson)}
${masterJson.WMA000 ? '' : 'WMA000: Otros (ninguna categoría aplica claramente)'}

### Instrucciones ###
- Recibirás mensajes numerados [0], [1], ...
- Para CADA mensaje devuelve el código que mejor aplica, confianza, evidencia literal y justificación breve.
- Si ninguna categoría encaja claramente, si el mensaje es poco representativo, muy aislado o de baja señal, usa WMA000.
- No fuerces una categoría solo porque existe una opción parecida.
- Responde ÚNICAMENTE con un JSON:
{
  "0": {"code": "WMA001", "confidence": 0.92, "evidence": ["fragmento literal"], "justification": "una oración breve"},
  "1": {"code": "WMA000", "confidence": 0.35, "evidence": [], "justification": "No encaja claramente con el maestro"}
}
- No incluyas texto adicional, solo el JSON.`;
}

// Un solo prompt por conversación produce las tres capas: etiqueta por turno,
// flujo comercial y fricciones. El origen no se pregunta: sale de la metadata.
function buildBBThreadSystemPrompt(masterJson, maxTags, taxonomy = {}) {
  const limitText = maxTags > 0 ? `máximo ${maxTags}` : 'máximo 4';
  const flowPrompts = taxonomy.flow?.prompts || {};
  const frictionsPrompt = taxonomy.frictions?.prompt || '';
  return `Eres un analista experto de conversaciones bancarias por correo.
Cada conversación es un hilo completo; sus turnos vienen numerados [1], [2], ... y separados por "||".

### Categorías disponibles ###
${buildCategoriesStr(masterJson)}
${masterJson.WMA000 ? '' : 'WMA000: Otros (ninguna categoría aplica claramente)'}

### 1. Etiqueta por turno ###
- Para CADA turno de CADA conversación devuelve el código que mejor describe ese turno concreto, con su confianza y evidencia literal.
- Usa "n" igual al número del turno tal como aparece en el hilo.
- Si el turno es residual (acuse, OOO, confirmación aislada) usa el código WMC que corresponda. WMA000 queda para turnos de negocio que no encajan.
- No uses más de ${limitText} códigos distintos dentro de una misma conversación.

### 2. Tipo de apertura ###
Se te indica el origen de cada conversación. Elige un valor de la lista permitida para ese origen.
${flowPrompts.Apertura || ''}

### 3. Gestión ###
${flowPrompts.Gestion || ''}
Elige solo entre: ${GESTION_LLM_VALUES.join(' | ')}. Los hilos donde solo habló un lado ya se resuelven por metadata y no se te preguntan.

### 4. Desenlace ###
${flowPrompts.Desenlace || ''}
Precedencia: una colocación verificada gana sobre cualquier otra señal. Un rechazo seguido de apelación viva no es rechazo, es incierto. Un proceso todavía en curso nunca se fuerza a un estado final.

### 5. Fricciones ###
Detecta las fricciones presentes en la conversación completa. Son cero o más; muchas solo se ven comparando turnos entre sí. Devuelve el id exacto, el número de turno donde nace ("n") y un fragmento literal como evidencia. Si no hay ninguna, devuelve una lista vacía.
${frictionsPrompt}

### Formato ###
Responde ÚNICAMENTE con JSON, una clave por conversación:
{
  "0": {
    "turnos": [
      {"n": 1, "code": "WMA001", "confidence": 0.92, "evidence": ["fragmento literal"]},
      {"n": 2, "code": "WMA000", "confidence": 0.4, "evidence": []}
    ],
    "apertura": "Inbound frío (conversación nueva)",
    "gestion": "Entregó documentos y nadie respondió jamás",
    "desenlace": "Entregó documentación; sin desenlace visible",
    "fricciones": [{"id": "FR-EC-02", "n": 3, "evidencia": "fragmento literal"}]
  }
}
- No incluyas texto adicional, solo el JSON.`;
}

function buildThreadUserPrompt(items) {
  return items.map((item, i) => {
    const allowed = APERTURA_BY_ORIGEN[item.origen] || [];
    return `[${i}] origen=${item.origen || 'desconocido'} turnos=${item.nTurnos}${
      allowed.length ? `\naperturas permitidas: ${allowed.join(' | ')}` : ''
    }
<hilo>
${item.text}
</hilo>`;
  }).join('\n\n');
}

// Aborta de verdad la request al vencer el timeout (libera el socket y avisa al proxy),
// en vez de solo rechazar la promesa JS y dejar la conexión colgada.
async function postWithAbortTimeout(url, body, ms, parentSignal) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await axios.post(url, body, { timeout: ms, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', onParentAbort);
  }
}

function unwrapJsonContent(content) {
  const trimmed = String(content || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractModelContent(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const anthropicText = blocks
    .filter(block => block?.type === 'text' || (block?.text && !block?.type))
    .map(block => block.text || '')
    .join('');
  const msg = data?.choices?.[0]?.message;
  const fromParts = Array.isArray(msg?.content)
    ? msg.content.map(part => part?.text || part?.content || '').join('')
    : '';
  return (typeof msg?.content === 'string' ? msg.content : '')
    || fromParts
    || anthropicText
    || msg?.refusal
    || data?.content?.[0]?.text
    || data?.output_text
    || '';
}

async function postTaggingModel({ model, messages, max_tokens, signal }) {
  const name = String(model || '');
  if (name.startsWith('claude-')) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const body = {
      model,
      system,
      messages: messages.filter(m => m.role !== 'system'),
      max_tokens,
    };
    // Sonnet 5: misma forma que el mapping de clustering (messages + max_tokens),
    // sin temperature. 4.6 sí la acepta.
    if (!/sonnet-5/i.test(name)) body.temperature = 0;
    const response = await postWithAbortTimeout(`${API_BASE}/proxy/anthropic`, body, CLASSIFY_TIMEOUT_MS, signal);
    const content = extractModelContent(response.data);
    if (!content) throw new Error('Respuesta vacía del modelo');
    return content;
  }

  // gpt-5.* es agéntico: max_completion_tokens, sin temperature (igual que 5.2 en etiquetado).
  // El presupuesto incluye razonamiento: si queda corto, el JSON sale truncado y el tablero vacío.
  const isGpt5 = /^gpt-5/i.test(name);
  const completionTokens = isGpt5 ? Math.max(Number(max_tokens) || 0, 0) * 3 + 2000 : max_tokens;
  const response = await postWithAbortTimeout(`${API_BASE}/proxy/openai`, {
    model,
    messages,
    response_format: { type: 'json_object' },
    ...(isGpt5
      ? { max_completion_tokens: completionTokens }
      : { temperature: 0, max_tokens }),
  }, CLASSIFY_TIMEOUT_MS, signal);
  const content = extractModelContent(response.data);
  if (!content) throw new Error('Respuesta vacía del modelo');
  return content;
}

function batchEntry(json, i) {
  return json?.[String(i)] ?? json?.[i] ?? json?.results?.[String(i)] ?? json?.results?.[i] ?? null;
}

function parseClassification(content, texts) {
  const json = JSON.parse(unwrapJsonContent(content));
  return texts.map((_, i) => {
    const item = batchEntry(json, i);
    if (typeof item === 'string') {
      return { code: item, confidence: 0, evidence: [], justification: '' };
    }
    return {
      code: String(item?.code || 'WMA000').trim(),
      confidence: Number(item?.confidence ?? 0),
      evidence: Array.isArray(item?.evidence) ? item.evidence : [],
      justification: typeof item?.justification === 'string' ? item.justification : '',
    };
  });
}

async function classifyBatch(texts, masterJson, model, signal) {
  const systemPrompt = buildBBSystemPrompt(masterJson);
  const userPrompt   = texts.map((t, i) => `[${i}]: ${t}`).join('\n');
  const content = await postTaggingModel({
    model,
    messages: [
      { role: 'system',  content: systemPrompt },
      { role: 'user',    content: userPrompt   },
    ],
    max_tokens: BATCH_SIZE * 120,
    signal,
  });
  return parseClassification(content, texts);
}

function emptyThreadClassification(code, justification) {
  return {
    turnos: [],
    apertura: '',
    gestion: '',
    desenlace: '',
    fricciones: [],
    fallbackCode: code,
    fallbackJustification: justification,
  };
}

function parseThreadClassification(content, items, masterJson, taxonomy = {}) {
  const json = JSON.parse(unwrapJsonContent(content));
  const frictionIds = taxonomy.frictions?.byId || {};
  return items.map((item, i) => {
    const entry = batchEntry(json, i) || {};
    const rawTurnos = Array.isArray(entry.turnos) ? entry.turnos : [];
    const turnos = rawTurnos
      .map((turno, idx) => {
        const code = String(turno?.code || '').trim();
        if (!code || (!masterJson[code] && code !== 'WMA000')) return null;
        const n = Number(turno?.n);
        return {
          n: Number.isFinite(n) && n >= 1 && n <= item.nTurnos ? Math.trunc(n) : idx + 1,
          code,
          confidence: Number(turno?.confidence ?? 0),
          evidence: Array.isArray(turno?.evidence) ? turno.evidence.filter(Boolean).map(String) : [],
        };
      })
      .filter(Boolean);

    const fricciones = (Array.isArray(entry.fricciones) ? entry.fricciones : [])
      .map(f => {
        const n = Number(f?.n);
        return {
          id: String(f?.id || '').trim(),
          n: Number.isFinite(n) && n >= 1 && n <= item.nTurnos ? Math.trunc(n) : '',
          evidencia: String(f?.evidencia || '').trim(),
        };
      })
      .filter(f => frictionIds[f.id])
      .filter((f, idx, arr) => arr.findIndex(o => o.id === f.id) === idx);

    return {
      turnos,
      apertura: String(entry.apertura || '').trim(),
      gestion: String(entry.gestion || '').trim(),
      desenlace: String(entry.desenlace || '').trim(),
      fricciones,
      fallbackCode: '',
      fallbackJustification: '',
    };
  });
}

async function classifyThreadBatch(items, masterJson, model, maxTags, signal, taxonomy) {
  const systemPrompt = buildBBThreadSystemPrompt(masterJson, maxTags, taxonomy);
  const userPrompt   = buildThreadUserPrompt(items);
  // La salida crece con los turnos, no con la cantidad de conversaciones: un
  // presupuesto fijo por conversación trunca los hilos largos.
  const turnBudget = items.reduce((sum, item) => sum + Math.max(1, item.nTurnos), 0) * 60;
  const content = await postTaggingModel({
    model,
    messages: [
      { role: 'system',  content: systemPrompt },
      { role: 'user',    content: userPrompt   },
    ],
    max_tokens: turnBudget + items.length * 260,
    signal,
  });
  return parseThreadClassification(content, items, masterJson, taxonomy);
}

async function classifyThreadBatchResilient(items, masterJson, model, maxTags, signal, taxonomy, depth = 0) {
  try {
    return await classifyThreadBatch(items, masterJson, model, maxTags, signal, taxonomy);
  } catch (e) {
    if (isAbortError(e)) throw e;
    if (items.length > 1 && depth < 2) {
      const mid = Math.ceil(items.length / 2);
      const [a, b] = await Promise.all([
        classifyThreadBatchResilient(items.slice(0, mid), masterJson, model, maxTags, signal, taxonomy, depth + 1),
        classifyThreadBatchResilient(items.slice(mid),    masterJson, model, maxTags, signal, taxonomy, depth + 1),
      ]);
      return [...a, ...b];
    }
    return items.map(() => emptyThreadClassification('ERROR', (e.message || String(e)).slice(0, 200)));
  }
}

// Reintenta un batch fallido dividiéndolo por la mitad; así una lentitud/parse puntual
// no manda 10 mensajes completos a ERROR. Devuelve clasificaciones alineadas con `texts`.
async function classifyBatchResilient(texts, masterJson, model, signal, depth = 0) {
  try {
    return await classifyBatch(texts, masterJson, model, signal);
  } catch (e) {
    if (isAbortError(e)) throw e;
    // Solo dividimos si vale la pena y no nos pasamos de profundidad.
    if (texts.length > 2 && depth < 2) {
      const mid = Math.ceil(texts.length / 2);
      const [a, b] = await Promise.all([
        classifyBatchResilient(texts.slice(0, mid), masterJson, model, signal, depth + 1),
        classifyBatchResilient(texts.slice(mid),    masterJson, model, signal, depth + 1),
      ]);
      return [...a, ...b];
    }
    // Último recurso: marcamos estos pocos como ERROR sin frenar el resto.
    return texts.map(() => ({
      code: 'ERROR',
      confidence: 0,
      evidence: [],
      justification: (e.message || String(e)).slice(0, 200),
    }));
  }
}

async function runBlackBoxEtiquetado(data, textColumn, masterJson, model, setProgress, isCancelled, signal) {
  const total   = data.length;
  const results = new Array(total);
  let completed = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (isCancelled()) throw new Error('CANCELLED');
      const start = nextIndex;
      nextIndex += BATCH_SIZE;
      if (start >= total) return;

      const end     = Math.min(start + BATCH_SIZE, total);
      const indices = Array.from({ length: end - start }, (_, k) => start + k);
      const texts   = indices.map(i => String(data[i][textColumn] || '').trim());

      // Skip empty rows
      const validMask  = texts.map(t => t.length > 0);
      const validTexts = texts.filter((_, k) => validMask[k]);

      let classifications = texts.map(() => ({
        code: 'VACÍO',
        confidence: 0,
        evidence: [],
        justification: 'Texto vacío — no se envió al modelo.',
      }));
      if (validTexts.length > 0) {
        try {
          const batch = await classifyBatchResilient(validTexts, masterJson, model, signal);
          let vi = 0;
          classifications = validMask.map(valid => valid
            ? (batch[vi++] || { code: 'WMA000', confidence: 0, evidence: [], justification: '' })
            : { code: 'VACÍO', confidence: 0, evidence: [], justification: 'Texto vacío — no se envió al modelo.' });
        } catch (e) {
          // classifyBatchResilient solo relanza en cancelación/abort.
          if (isCancelled() || isAbortError(e)) throw new Error('CANCELLED');
          classifications = texts.map(() => ({
            code: 'ERROR',
            confidence: 0,
            evidence: [],
            justification: e.message || String(e),
          }));
        }
      }

      indices.forEach((rowIdx, k) => {
        const classification = classifications[k];
        results[rowIdx] = {
          ...data[rowIdx],
          CategoriaAsignada: classification.code,
          Confianza: classification.confidence,
          Evidencia: classification.evidence.join(' | '),
          Justificacion: classification.justification,
        };
      });

      completed += indices.length;
      setProgress(Math.round((completed / total) * 100));
    }
  };

  const workers = Math.min(CONCURRENCY, Math.ceil(total / BATCH_SIZE));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

// Proyecta las etiquetas por turno sobre la fila de conversación y resuelve el
// flujo con la metadata mandando por sobre lo que dijo el modelo.
function buildThreadResultRow(row, classification, frictionsById = {}) {
  const turnos = classification.turnos || [];
  const principal = turnos.length
    ? aggregatePrincipalCategory(turnos)
    : { code: classification.fallbackCode || 'WMA000', confidence: 0, secondary: [] };
  const evidence = turnos
    .filter(t => t.code === principal.code)
    .flatMap(t => t.evidence)
    .filter(Boolean);

  const origen = origenFromRow(row);
  const gestion = resolveGestion(classification.gestion, row);
  const apertura = resolveApertura(classification.apertura, origen, row);
  const desenlace = normalizeClosed(classification.desenlace, DESENLACE_VALUES, '');
  const fricciones = classification.fricciones || [];

  return {
    ...row,
    CategoriaAsignada: principal.code,
    Confianza: principal.confidence,
    Evidencia: evidence.join(' | '),
    Justificacion: classification.fallbackJustification || '',
    TipificacionesSecundarias: principal.secondary.join('; '),
    TagsHilo: turnos.map(t => `${t.n}:${t.code}:${t.confidence}`).join(' | '),
    Origen: origen,
    Apertura: apertura,
    Gestion: gestion,
    Desenlace: desenlace,
    Derivado: desenlace === 'Derivación u otro producto' ? 'True' : 'False',
    Fricciones: fricciones.map(f => f.id).join('; '),
    FriccionesNombres: fricciones.map(f => frictionsById[f.id]?.nombre || f.id).join('; '),
    MacroFricciones: [...new Set(fricciones.map(f => frictionsById[f.id]?.macro).filter(Boolean))].join('; '),
    EvidenciaFricciones: fricciones.map(f => `${f.id}: ${f.evidencia}`).filter(Boolean).join(' | '),
    FriccionIniciaEnHilo: fricciones.filter(f => f.id && f.n).map(f => `${f.id}:${f.n}`).join('; '),
    __turnos: turnos,
    __fricciones: fricciones,
  };
}

async function runBlackBoxThreadEtiquetado(data, textColumn, masterJson, model, maxTags, setProgress, isCancelled, signal, taxonomy = {}) {
  const total   = data.length;
  const results = new Array(total);
  const frictionsById = taxonomy.frictions?.byId || {};
  let completed = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (isCancelled()) throw new Error('CANCELLED');
      const start = nextIndex;
      nextIndex += THREAD_BATCH_SIZE;
      if (start >= total) return;

      const end     = Math.min(start + THREAD_BATCH_SIZE, total);
      const indices = Array.from({ length: end - start }, (_, k) => start + k);
      const items   = indices.map(i => ({
        text: String(data[i][textColumn] || '').trim(),
        origen: origenFromRow(data[i]),
        nTurnos: Math.max(1, Number(data[i].n_mensajes_hilo) || 1),
      }));

      let classifications = items.map(() => emptyThreadClassification('VACÍO', 'Texto vacío — no se envió al modelo.'));

      const validMask  = items.map(item => item.text.length > 0);
      const validItems = items.filter((_, k) => validMask[k]);
      if (validItems.length > 0) {
        try {
          const batch = await classifyThreadBatchResilient(validItems, masterJson, model, maxTags, signal, taxonomy);
          let vi = 0;
          classifications = validMask.map(valid => valid
            ? (batch[vi++] || emptyThreadClassification('WMA000', ''))
            : emptyThreadClassification('VACÍO', 'Texto vacío — no se envió al modelo.'));
        } catch (e) {
          if (isCancelled() || isAbortError(e)) throw new Error('CANCELLED');
          classifications = items.map(() => emptyThreadClassification('ERROR', e.message || String(e)));
        }
      }

      indices.forEach((rowIdx, k) => {
        results[rowIdx] = buildThreadResultRow(data[rowIdx], classifications[k], frictionsById);
      });

      completed += indices.length;
      setProgress(Math.round((completed / total) * 100));
    }
  };

  const workers = Math.min(THREAD_CONCURRENCY, Math.ceil(total / THREAD_BATCH_SIZE));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}


const PHASE_LABELS = [
  '',
  'Cargando catálogo',
  'Levantando maestro',
  'Etiquetando',
  'Analizando resultados',
  'Listo',
];


// ─── Helpers ──────────────────────────────────────────────────────────────────
function readOtbbCache() {
  try {
    const raw = localStorage.getItem(OTBB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeOtbbCache(value) {
  try {
    if (!value) localStorage.removeItem(OTBB_STORAGE_KEY);
    // ponytail: localStorage is enough for tab switching; very large datasets should move to IndexedDB.
    else localStorage.setItem(OTBB_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // cuota excedida: no rompemos el procesamiento por el cache.
  }
}

function isAbortError(error) {
  return error?.name === 'CanceledError'
    || error?.code === 'ERR_CANCELED'
    || /cancel|abort/i.test(String(error?.message || ''));
}

function summarizeThreadWmcSignals(threadRows = [], detailRows = []) {
  const totalThreads = threadRows.length;
  const totalInteractions = detailRows.length;
  const detailsWithWmc = detailRows.filter(row => row.wmc_code);
  const threadsWithWmc = threadRows.filter(row => Number(row.n_interacciones_wmc || row.wmc_hits_count || 0) > 0);
  const threadsWithMultipleWmcTypes = threadRows.filter(row => String(row.wmc_codes || '')
    .split(/[;,]/)
    .map(code => code.trim())
    .filter(Boolean).length >= 2
  );
  const dominantWmcThreads = threadRows.filter(row => {
    const wmcCount = Number(row.n_interacciones_wmc || row.wmc_hits_count || 0);
    const total = Number(row.n_interacciones || row.n_mensajes_hilo || 0);
    return total > 0 && (wmcCount / total) > 0.5;
  });
  const pureWmcThreads = threadRows.filter(row => {
    const wmcCount = Number(row.n_interacciones_wmc || row.wmc_hits_count || 0);
    const total = Number(row.n_interacciones || row.n_mensajes_hilo || 0);
    return total > 0 && wmcCount === total;
  });
  const byCode = {};
  detailsWithWmc.forEach(row => {
    const code = row.wmc_code;
    if (!code) return;
    byCode[code] = byCode[code] || {
      code,
      n_interacciones: 0,
      threadIds: new Set(),
      evidencia: row.wmc_evidencia || '',
      tratamiento: row.wmc_tratamiento || '',
    };
    byCode[code].n_interacciones += 1;
    if (row.thread_id) byCode[code].threadIds.add(row.thread_id);
  });

  return {
    totalThreads,
    totalInteractions,
    threadsWithWmc: threadsWithWmc.length,
    interactionsWithWmc: detailsWithWmc.length,
    pctThreadsWithWmc: pct(threadsWithWmc.length, totalThreads),
    pctInteractionsWithWmc: pct(detailsWithWmc.length, totalInteractions),
    avgWmcPerThread: round1(detailsWithWmc.length / Math.max(totalThreads, 1)),
    threadsWithMultipleWmcTypes: threadsWithMultipleWmcTypes.length,
    pctThreadsWithMultipleWmcTypes: pct(threadsWithMultipleWmcTypes.length, totalThreads),
    dominantWmcThreads: dominantWmcThreads.length,
    pctDominantWmcThreads: pct(dominantWmcThreads.length, totalThreads),
    pureWmcThreads: pureWmcThreads.length,
    pctPureWmcThreads: pct(pureWmcThreads.length, totalThreads),
    byCode: Object.values(byCode)
      .map(item => ({
        code: item.code,
        n_hilos: item.threadIds.size,
        n_interacciones: item.n_interacciones,
        // Cobertura: % de hilos donde aparece (puede sumar >100% entre códigos).
        pct_hilos: pct(item.threadIds.size, totalThreads),
        // Distribución: % entre turnos que sí tienen WMC (debe acercarse a 100% entre todos los códigos).
        pct_interacciones: pct(item.n_interacciones, detailsWithWmc.length),
        // Contexto opcional: % sobre todas las interacciones del dataset.
        pct_interacciones_total: pct(item.n_interacciones, totalInteractions),
        evidencia: item.evidencia,
        tratamiento: item.tratamiento,
      }))
      .sort((a, b) => b.n_interacciones - a.n_interacciones),
  };
}

// Bag-of-words cosine similarity (local, sin API).
// Tokeniza palabras ≥ 3 chars, calcula el producto punto sobre vectores de frecuencia.
function _tokenize(text) {
  return String(text || '').toLowerCase().match(/\b\w{3,}\b/g) || [];
}
function _bow(tokens) {
  const bag = {};
  tokens.forEach(t => { bag[t] = (bag[t] || 0) + 1; });
  return bag;
}
function _cosineSim(a, b) {
  const bowA = _bow(_tokenize(a));
  const bowB = _bow(_tokenize(b));
  const keys = new Set([...Object.keys(bowA), ...Object.keys(bowB)]);
  let dot = 0, magA = 0, magB = 0;
  keys.forEach(k => {
    const va = bowA[k] || 0;
    const vb = bowB[k] || 0;
    dot  += va * vb;
    magA += va * va;
    magB += vb * vb;
  });
  return (magA && magB) ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

function topExamplesForCode(rows, code, textColumn, masterJson, limit = 5) {
  // Extraemos la definición del maestro para calcular similitud semántica local.
  const rawDef = masterJson?.[code] || '';
  const defMatch = rawDef.match(/\[(.+)\]$/s);
  const definition = defMatch ? defMatch[1] : rawDef;

  return rows
    .filter(r => rowHasCode(r, code))
    .map(r => {
      const text       = String(r[textColumn] || '').trim();
      const confidence = Number(r.Confianza || 0);
      // Score combinado: 60% similitud coseno con la definición + 40% confidence del modelo.
      const sim   = definition ? _cosineSim(text, definition) : 0;
      const score = sim * 0.6 + confidence * 0.4;
      return { text, confidence, evidence: r.Evidencia || '', justification: r.Justificacion || '', score };
    })
    .filter(e => e.text)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function rowCodes(row, includeSecondary = false) {
  const codes = [];
  const primary = String(row.CategoriaAsignada || '').trim();
  if (primary && primary !== 'VACÍO' && primary !== 'ERROR') codes.push(primary);
  if (includeSecondary) {
    String(row.TipificacionesSecundarias || '')
      .split(/[;,]/)
      .map(v => v.trim())
      .filter(Boolean)
      .forEach(code => {
        if (code !== 'VACÍO' && code !== 'ERROR' && !codes.includes(code)) codes.push(code);
      });
  }
  return codes;
}

function rowHasCode(row, code) {
  return rowCodes(row, true).includes(code);
}

/**
 * Cobertura multi-categoría a nivel hilo (= mensaje/interacción).
 * Hereda las tipificaciones de la conversación padre sobre cada fila de Detalle_hilos.
 * Así no es redundante con "categoría principal" (1 por conversación / thread_id).
 */
function buildHiloMultiCoverageDistribution(taggedRows = [], detailRows = [], metaMap, textColumn, masterJson = {}) {
  const byThread = new Map((taggedRows || []).map(row => [String(row.thread_id || ''), row]));
  const details = detailRows || [];
  if (!details.length) {
    return buildDistribution(taggedRows, metaMap, textColumn, masterJson, {
      multiTag: true,
      countLabel: 'hilos',
    });
  }
  const expanded = details.map((detail, i) => {
    const parent = byThread.get(String(detail.thread_id || '')) || {};
    return {
      CategoriaAsignada: parent.CategoriaAsignada,
      TipificacionesSecundarias: parent.TipificacionesSecundarias,
      TagsHilo: parent.TagsHilo,
      content_hilo: detail.content_hilo || '',
      subject_hilo: detail.subject_hilo || '',
      // Clave única por mensaje para contar hilos, no conversaciones.
      thread_id: `${detail.thread_id}::msg::${detail.orden_hilo || i}`,
      __otbbRowIndex: i,
    };
  });
  return buildDistribution(
    expanded,
    metaMap,
    textColumn === 'transcript_hilo' ? 'content_hilo' : textColumn,
    masterJson,
    { multiTag: true, countLabel: 'hilos' }
  );
}

// Build { tipificacion → count } from tagged rows
function buildDistribution(rows, metaMap, textColumn, masterJson = {}, options = {}) {
  const counts = {};
  rows.forEach((r, idx) => {
    const rowKey = String(r.thread_id || (r.__otbbRowIndex ?? idx));
    rowCodes(r, options.multiTag).forEach(code => {
      if (!counts[code]) counts[code] = { n: 0, rowKeys: new Set() };
      counts[code].n += 1;
      counts[code].rowKeys.add(rowKey);
    });
  });
  // threadUnit: unidad = fila/hilo (principal o multi-tag). totalBase = N filas, no suma de códigos.
  const threadUnit = Boolean(options.threadUnit || options.multiTag);
  const total = threadUnit
    ? rows.length
    : Object.values(counts).reduce((a, b) => a + b.n, 0);
  const countLabel = options.countLabel || (threadUnit ? 'hilos' : 'msgs');
  return Object.entries(counts)
    .map(([code, data]) => ({
      code,
      n: threadUnit ? data.rowKeys.size : data.n,
      rowKeys: [...data.rowKeys],
      totalBase: total,
      countLabel,
      pct: pct(threadUnit ? data.rowKeys.size : data.n, total),
      industria:     metaMap[code]?.industria     || '',
      categoria:     metaMap[code]?.categoria     || (code === 'WMA000' ? 'Otros' : '—'),
      subcategoria:  metaMap[code]?.subcategoria  || '',
      producto:      metaMap[code]?.producto      || '',
      macroProducto: metaMap[code]?.macroProducto || '',
      moduloJourney: metaMap[code]?.moduloJourney || '',
      decisionFlow:  metaMap[code]?.decisionFlow  || '',
      casoUso:       metaMap[code]?.casoUso       || '',
      // WMB emergente entrega `journey`; el catálogo de banca lo llama `moduloJourney`.
      journey:       metaMap[code]?.journey       || metaMap[code]?.moduloJourney || '',
      etapaComercial:metaMap[code]?.etapaComercial|| '',
      tipoInteraccion:metaMap[code]?.tipoInteraccion|| '',
      areaResponsable:metaMap[code]?.areaResponsable|| '',
      segmento:      metaMap[code]?.segmento      || '',
      capacidadWird: metaMap[code]?.capacidadWird || '',
      adjuntos:      metaMap[code]?.adjuntos      || '',
      tipo:          metaMap[code]?.tipo          || 'catalogo',
      origen:        metaMap[code]?.origen        || '',
      accionable:    metaMap[code]?.accionable    || false,
      tratamiento:   metaMap[code]?.tratamiento   || '',
      beneficio:     metaMap[code]?.beneficio     || '',
      friccion:      metaMap[code]?.friccion      || '',
      sentimiento:   metaMap[code]?.sentimiento   || '',
      examples:      topExamplesForCode(rows, code, textColumn, masterJson, 5),
    }))
    .sort((a, b) => b.n - a.n);
}

function fullCategoryName(item = {}) {
  const clean = (value) => String(value || '')
    .trim()
    .replace(/\s+-\s*$/g, '');
  const category = clean(item.categoria);
  const subcategory = clean(item.subcategoria);
  if (subcategory && category && subcategory.toLowerCase().startsWith(category.toLowerCase())) return subcategory;
  if (category && subcategory) return `${category} - ${subcategory}`;
  return category || subcategory || item.code || 'Sin categoría';
}

function codeCategoryLabel(item = {}) {
  const code = String(item.code || '').trim();
  const name = fullCategoryName(item);
  if (code && name && name !== code) return `${code} - ${name}`;
  return code || name || 'Sin categoría';
}

function isThreadDistribution(distribution = []) {
  return distribution.some(d => d.countLabel === 'hilos' || d.countLabel === 'conversaciones');
}

function isExclusionCategory(item = {}) {
  return item.code?.startsWith('WMC') || item.tipo === 'exclusion';
}

function hasBusinessMetadata(item = {}) {
  return Boolean(
    item.producto ||
    item.macroProducto ||
    item.moduloJourney ||
    item.decisionFlow ||
    item.casoUso ||
    item.journey ||
    item.etapaComercial ||
    item.tipoInteraccion ||
    item.areaResponsable ||
    item.segmento ||
    item.capacidadWird ||
    item.adjuntos
  );
}

function isBusinessCategory(item = {}) {
  if (isExclusionCategory(item)) return false;
  if (item.code === 'WMA000') return false;
  return hasBusinessMetadata(item);
}

function businessDistributionForAnalytics(distribution = []) {
  const business = distribution.filter(isBusinessCategory);
  const residual = distribution.filter(item => !isBusinessCategory(item) && !isExclusionCategory(item));
  const countLabel = distribution[0]?.countLabel || 'msgs';
  const threadMode = isThreadDistribution(distribution) || countLabel === 'hilos';
  const exclusionKeys = new Set();
  distribution.filter(isExclusionCategory).forEach(item => (item.rowKeys || []).forEach(key => exclusionKeys.add(key)));
  const exclusionN = threadMode
    ? exclusionKeys.size
    : distribution.filter(isExclusionCategory).reduce((sum, item) => sum + (item.n || 0), 0);
  const totalBase = Math.max(0, (distribution[0]?.totalBase || 0) - exclusionN);
  const withBase = item => ({ ...item, totalBase, pct: pct(item.n, totalBase) });
  if (!residual.length) return business.map(withBase);

  // Bucket residual para que producto/etapa/etc. cierren en 100% del universo no-WMC.
  const rowKeys = new Set();
  residual.forEach(item => (item.rowKeys || []).forEach(key => rowKeys.add(key)));
  const n = threadMode ? rowKeys.size : residual.reduce((sum, item) => sum + (item.n || 0), 0);
  return [
    ...business.map(withBase),
    {
      code: '__SIN_NEGOCIO__',
      n,
      rowKeys: [...rowKeys],
      totalBase,
      countLabel,
      pct: pct(n, totalBase),
      industria: '',
      categoria: 'Sin metadata de negocio',
      subcategoria: '',
      producto: 'Sin producto / fuera de negocio',
      macroProducto: 'Sin macro producto',
      moduloJourney: '',
      decisionFlow: '',
      casoUso: 'Sin caso de uso',
      journey: SIN_JOURNEY,
      etapaComercial: 'Sin etapa',
      tipoInteraccion: '',
      areaResponsable: '',
      segmento: 'Sin segmento',
      capacidadWird: 'Sin capacidad definida',
      adjuntos: 'Sin dato',
      tipo: 'residual',
      examples: [],
    },
  ];
}

function exclusionDistributionForAnalytics(distribution = []) {
  return distribution.filter(isExclusionCategory);
}

function rowKeySetForItems(items = []) {
  const set = new Set();
  items.forEach(item => (item.rowKeys || []).forEach(rowKey => set.add(rowKey)));
  return set;
}

function coverageCountForItems(items = []) {
  return isThreadDistribution(items)
    ? rowKeySetForItems(items).size
    : items.reduce((sum, item) => sum + item.n, 0);
}

// ─── Phase Step Indicator ─────────────────────────────────────────────────────
function PhaseIndicator({ phase, progress, wmbEnabled }) {
  const steps = wmbEnabled
    ? ['Catálogo', 'Levantamiento', 'Etiquetado', 'Levantando Otros', 'Análisis', 'Listo']
    : ['Catálogo', 'Levantamiento', 'Etiquetado', 'Análisis', 'Listo'];

  // Con WMB activo: fases 1-6; sin WMB: fases 1-5. El número de fase en el pipeline no cambia.
  // Mapeamos phase (pipeline) → índice en steps:
  // sin WMB:  1=Catálogo(0) 2=Levantamiento(1) 3=Etiquetado(2) 4=Análisis(3) 5=Listo(4)
  // con WMB:  1=Catálogo(0) 2=Levantamiento(1) 3=Etiquetado(2) 3.5≡fase3b=LevOtros(3) 4=Análisis(4) 5=Listo(5)
  // Usamos phaseDisplay para esto:
  const phaseDisplay = phase; // pipeline phases se pasan directamente; Fase 3b usa valor 3.5

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        {steps.map((label, i) => {
          const s = i + 1;
          const done   = s < phaseDisplay;
          const active = Math.floor(phaseDisplay) === s || (phaseDisplay === 3.5 && s === 4 && wmbEnabled);
          return (
            <div key={s} className="flex items-center gap-1.5">
              <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border-2
                ${done   ? 'bg-emerald-500 border-emerald-500 text-white'
                         : active ? 'bg-indigo-600 border-indigo-600 text-white animate-pulse'
                         : 'bg-white border-slate-300 text-slate-400'}`}>
                {done ? '✓' : s}
              </span>
              <span className={`text-xs font-medium ${active ? 'text-indigo-700' : done ? 'text-emerald-600' : 'text-slate-400'}`}>
                {label}
              </span>
              {i < steps.length - 1 && <span className="text-slate-200 text-sm mx-0.5">›</span>}
            </div>
          );
        })}
      </div>

      {/* Barras de progreso para fases con % */}
      {(phase === 1.7 || phase === 2 || phase === 3 || phase === 3.5 || phase === 3.7) && (
        <div className="space-y-1">
          <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div className="h-1.5 rounded-full bg-indigo-500 transition-all duration-200"
                 style={{ width: `${progress}%` }} />
          </div>
          <p className="text-xs text-slate-500">
            {progress}% · {
              phase === 1.7  ? 'Filtrando ruido operativo (motor de exclusiones)' :
              phase === 2    ? 'Extrayendo temáticas y construyendo maestro' :
              phase === 3    ? 'Clasificando' :
              phase === 3.7  ? 'Analizando sentimiento' :
                               'Levantando categorías emergentes de Otros'
            }
          </p>
        </div>
      )}
      {phase === 1 && (
        <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
          <div className="h-1.5 rounded-full bg-indigo-500 animate-pulse" style={{ width: '100%' }} />
        </div>
      )}
    </div>
  );
}

// ─── Treemap ──────────────────────────────────────────────────────────────────
const COLORS = ['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6'];

function Treemap({ distribution }) {
  // Group by producto
  const byProduct = {};
  distribution.forEach(d => {
    const key = d.producto || 'Sin producto';
    if (!byProduct[key]) byProduct[key] = [];
    byProduct[key].push(d);
  });

  const products = Object.entries(byProduct).sort((a, b) =>
    coverageCountForItems(b[1]) - coverageCountForItems(a[1])
  );
  const totalAll = distribution[0]?.totalBase || distribution.reduce((s, d) => s + d.n, 0);
  const countLabel = distribution[0]?.countLabel || 'msgs';

  return (
    <div className="space-y-4">
      {products.map(([prod, items], pi) => {
        const prodTotal = coverageCountForItems(items);
        const prodPct = pct(prodTotal, totalAll);
        const color = COLORS[pi % COLORS.length];
        return (
          <div key={prod}>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />
              <span className="text-sm font-semibold text-gray-800">{prod}</span>
              <span className="text-xs text-gray-400 ml-auto">{prodPct}% · {prodTotal} {countLabel}</span>
            </div>
            <div className="flex flex-wrap gap-1.5 pl-5">
              {items.map(item => (
                <div key={item.code}
                     title={`${codeCategoryLabel(item)}\n${item.n} ${countLabel} (${item.pct}%)`}
                     className="rounded-lg px-2.5 py-1.5 text-white text-xs font-medium cursor-default"
                     style={{ background: color, opacity: 0.4 + (item.pct / 100) * 0.6 }}>
                  <span className="font-mono opacity-80">{item.code}</span>
                  <span className="mx-1">·</span>
                  <span>{item.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Distribution Table (editable inline) ────────────────────────────────────
function EditableCell({ value, onSave, className = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  const inputRef = useRef(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        className="w-full text-xs border border-indigo-300 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white" />
    );
  }
  return (
    <span
      className={`${className} group relative cursor-text`}
      onClick={() => setEditing(true)}
      title="Haz clic para editar">
      {value || '—'}
      <span className="ml-1 opacity-0 group-hover:opacity-40 text-[9px] text-indigo-500">✎</span>
    </span>
  );
}

function DistributionTable({ distribution, onEditMeta, threadMode = false, nLabel, pctLabel }) {
  const [sortKey, setSortKey] = useState('n');
  const [asc, setAsc] = useState(false);

  const sorted = [...distribution].sort((a, b) => {
    const va = a[sortKey] ?? 0;
    const vb = b[sortKey] ?? 0;
    return asc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  const th = (key, label) => (
    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 cursor-pointer select-none hover:text-indigo-600"
        onClick={() => { setSortKey(key); setAsc(sortKey === key ? !asc : false); }}>
      {label}{sortKey === key ? (asc ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div className="overflow-auto rounded-xl border border-gray-100">
      {onEditMeta && (
        <div className="px-3 py-2 bg-indigo-50/60 border-b border-indigo-100 text-[10px] text-indigo-500 flex items-center gap-1.5">
          <span>✎</span>
          <span>Haz clic en las partes del nombre completo para editar categoría o subcategoría. Los cambios se reflejan en los exports.</span>
        </div>
      )}
      <table className="w-full text-sm border-collapse">
        <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
          <tr>
            {th('code',          'Tipificación')}
            {th('categoria',     'Categoría completa')}
            {th('n',             nLabel || (threadMode ? 'N conversaciones' : 'N'))}
            {th('pct',           pctLabel || (threadMode ? '% cobertura conversaciones' : '% sobre total'))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((d, i) => (
            <tr key={d.code} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
              <td className="px-3 py-2 text-xs text-gray-500">
                <span className="font-mono">{d.code}</span>
                {d.code?.startsWith('WMB') && (
                  <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 text-violet-700 uppercase tracking-wide">IA</span>
                )}
                {d.code?.startsWith('WMC') && (
                  <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-100 text-orange-700 uppercase tracking-wide">EXC</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-gray-800 max-w-[420px]">
                {onEditMeta ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <EditableCell value={d.categoria} className="text-gray-800 font-medium"
                      onSave={v => onEditMeta(d.code, 'categoria', v)} />
                    {d.subcategoria && (
                      <>
                        <span className="text-gray-300">-</span>
                        <EditableCell value={d.subcategoria} className="text-gray-600"
                          onSave={v => onEditMeta(d.code, 'subcategoria', v)} />
                      </>
                    )}
                  </div>
                ) : (
                  <span className="truncate" title={codeCategoryLabel(d)}>{codeCategoryLabel(d)}</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs font-semibold text-gray-800 tabular-nums">{d.n}</td>
              <td className="px-3 py-2 text-xs tabular-nums">
                <div className="flex items-center gap-1.5">
                  <div className="w-16 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                    <div className="h-full rounded-full bg-indigo-400" style={{ width: `${Math.min(d.pct, 100)}%` }} />
                  </div>
                  <span className="text-gray-700">{d.pct}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryDistributionBlock({ title, description, distribution, onEditMeta, nLabel, pctLabel }) {
  return (
    <div className="rounded-xl border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/60">
        <p className="text-sm font-semibold text-gray-800">{title}</p>
        {description && <p className="text-xs text-gray-400 mt-0.5">{description}</p>}
      </div>
      <div className="p-4">
        <DistributionTable
          distribution={distribution}
          onEditMeta={onEditMeta}
          threadMode
          nLabel={nLabel}
          pctLabel={pctLabel}
        />
      </div>
    </div>
  );
}

function ExclusionCoveragePanel({ distribution }) {
  if (!distribution?.length) return null;
  const total = distribution[0]?.totalBase || distribution.reduce((sum, item) => sum + item.n, 0);
  return (
    <div className="bg-white border border-orange-100 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-orange-100 bg-orange-50/40">
        <h3 className="font-semibold text-gray-800 text-sm">Exclusiones detectadas</h3>
        <p className="text-xs text-gray-400 mt-0.5">WMC detectadas por hilo dentro de la conversación, separadas de las analíticas de negocio</p>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-white border-b border-gray-100">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">WMC</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Subcategoría</th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500">N hilos</th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500">% sobre total de hilos</th>
            </tr>
          </thead>
          <tbody>
            {distribution.map((item, i) => (
              <tr key={item.code} className={i % 2 === 0 ? 'bg-white' : 'bg-orange-50/20'}>
                <td className="px-4 py-2 text-xs font-mono text-gray-600">{item.code}</td>
                <td className="px-4 py-2 text-xs text-gray-700">{item.subcategoria || item.categoria || 'Exclusión'}</td>
                <td className="px-4 py-2 text-xs text-right font-semibold text-gray-800">{item.n}</td>
                <td className="px-4 py-2 text-xs text-right text-gray-700">{pct(item.n, total)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ThreadPreanalysisPanel({ summary }) {
  if (!summary) return null;
  const fmt = (value) => Number(value || 0).toLocaleString('es-CL');
  const baseCards = [
    { label: 'Conversaciones', value: fmt(summary.totalThreads) },
    { label: 'Hilos', value: fmt(summary.totalInteractions) },
    { label: 'Duración promedio', value: `${summary.avgDurationHours || 0} hrs` },
    { label: 'Respuesta promedio', value: `${summary.avgResponseHours || 0} hrs` },
  ];
  const riskCards = [
    { label: 'Conversaciones multi-hilo', value: fmt(summary.multiInteractionThreads) },
    { label: 'Conversaciones pendientes', value: fmt(summary.pendingThreads) },
    { label: 'Respuesta p50', value: `${summary.p50ResponseHours || 0} hrs` },
    { label: 'Respuesta p90', value: `${summary.p90ResponseHours || 0} hrs` },
  ];
  const timeBucketEntries = (obj = {}) => ['<=1h', '1-4h', '4-24h', '1-3d', '>3d']
    .map(label => [label, obj[label] || 0])
    .filter(([, n]) => n > 0);
  // Quién participó en el hilo, en una sola dimensión (el flag `Is Internal`),
  // así todos los hilos caen en alguna categoría y ninguno queda fuera del
  // gráfico. Ver `participacion_hilo` en threading.js.
  // Las tres se muestran siempre, incluso en cero: un "Externo 0" dice que no
  // hubo un solo hilo puro cara al cliente, que es justo lo que hay que ver.
  const participacionDist = summary.participacionHiloDistribution || {};
  const origenItems = [
    ['Mixto', participacionDist.mixto || 0],
    ['Interno', participacionDist.interno || 0],
    ['Externo', participacionDist.externo || 0],
  ];
  return (
    <div className="rounded-xl border border-indigo-100 bg-white p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-gray-800">Pre-análisis de conversaciones</p>
        <p className="text-xs text-gray-400 mt-0.5">
          Resumen técnico previo al uso de IA. Deduplicados: {fmt(summary.duplicateRows || 0)} registros.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {baseCards.map(card => (
          <MetricCard key={card.label} {...card} />
        ))}
      </div>

      <div className="rounded-lg border border-rose-100 bg-rose-50/30 p-3">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div>
            <p className="text-xs font-semibold text-gray-700">Riesgo y SLA</p>
            <p className="text-[11px] text-gray-400 mt-0.5">Indicadores de complejidad, pendientes y cola de respuesta.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {riskCards.map(card => (
            <MetricCard key={card.label} {...card} tone="rose" />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <BucketHistogram title="Bucket de tiempo de respuesta" items={timeBucketEntries(summary.responseBuckets)} />
        <BucketHistogram title="Bucket de duración conversacional" items={timeBucketEntries(summary.durationBuckets)} />
        <MiniBucket
          title="Origen de la conversación"
          note={summary.internalColumn
            ? `Metadato: ${summary.internalColumn} · ${fmt(summary.internalMessagesTotal || 0)} msgs internos`
            : 'Sin columna de metadato interno mapeada'}
          items={origenItems}
        />
      </div>

      {!summary.internalColumnDetected && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          No se detectó la columna de metadato interno (p. ej. «Is Internal»). Todos los hilos quedan como Externo.
          Selecciónala en el mapeo de columnas para distinguir reenvíos internos.
        </p>
      )}
      {summary.internalColumnDetected && summary.internalMessagesTotal === 0 && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          Columna «{summary.internalColumn}» mapeada, pero ningún mensaje aparece como interno.
          Revisa que el export traiga valores True/1/Sí (o Interno) en esa columna.
        </p>
      )}

      {summary.topDomains?.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-600 mb-2">Dominios más presentes</p>
          <div className="flex flex-wrap gap-2">
            {summary.topDomains.map(([domain, n]) => (
              <span key={domain} className="px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs border border-indigo-100">
                {domain} · {fmt(n)}
              </span>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

// Segundo bloque del pre-análisis, debajo del de conversaciones: qué marcó el
// motor de exclusiones sobre este archivo, antes de que el LLM vea una sola
// línea. Nada se borra — el motor solo anota categoría y evidencia.
function ExclusionPreanalysisPanel({ data, state }) {
  if (state === 'idle' && !data) return null;
  const fmt = (value) => Number(value || 0).toLocaleString('es-CL');

  if (state === 'loading') {
    return (
      <div className="rounded-xl border border-indigo-100 bg-white p-4">
        <p className="text-sm font-semibold text-gray-800">Pre-análisis de exclusiones</p>
        <p className="text-xs text-gray-400 mt-0.5">Consultando el motor de exclusiones…</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-4">
        <p className="text-sm font-semibold text-gray-800">Pre-análisis de exclusiones</p>
        <p className="text-xs text-gray-500 mt-0.5">
          El motor de exclusiones no está disponible. El análisis puede correr igual: los hilos se etiquetan sin marcar ruido operativo.
        </p>
      </div>
    );
  }

  if (!data) return null;
  const { exclusion } = data;
  const pctExcluidos = exclusion.mensajesEvaluados
    ? Math.round((exclusion.excluidos / exclusion.mensajesEvaluados) * 1000) / 10
    : 0;
  const cards = [
    { label: 'Mensajes excluidos', value: `${fmt(exclusion.excluidos)} (${pctExcluidos}%)` },
    { label: 'Duplicados de archivo', value: fmt(exclusion.duplicadosArchivo) },
    { label: 'Ahorro de texto', value: `${exclusion.ahorroTextoPct}%` },
    { label: 'Hilos con insistencia', value: fmt(exclusion.hilosConInsistencia) },
  ];

  return (
    <div className="rounded-xl border border-indigo-100 bg-white p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-gray-800">Pre-análisis de exclusiones</p>
        <p className="text-xs text-gray-400 mt-0.5">
          Ruido operativo detectado sobre {fmt(exclusion.mensajesEvaluados)} mensajes, antes de usar IA. Nada se borra: cada mensaje queda marcado con su categoría y evidencia.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map(card => (
          <MetricCard key={card.label} {...card} tone="orange" />
        ))}
      </div>

      {exclusion.categorias.length > 0 && (
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
          <p className="text-xs font-semibold text-gray-600 mb-2">Categorías de exclusión</p>
          <div className="grid grid-cols-[1fr_70px_70px] gap-2 mb-1">
            <span className="text-[10px] uppercase font-semibold tracking-wide text-gray-400">Categoría</span>
            <span className="text-[10px] uppercase font-semibold tracking-wide text-gray-400 text-right">N</span>
            <span className="text-[10px] uppercase font-semibold tracking-wide text-gray-400 text-right">%</span>
          </div>
          {exclusion.categorias.map(row => (
            <div key={row.categoria} className="grid grid-cols-[1fr_70px_70px] gap-2 items-center py-1.5 border-t border-slate-100">
              <span className="text-xs text-gray-700 truncate" title={row.categoria}>{row.categoria}</span>
              <span className="text-xs font-semibold text-gray-800 text-right">{fmt(row.n)}</span>
              <span className="text-xs text-gray-500 text-right">{row.pct}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-50 border-slate-100',
    rose: 'bg-white/70 border-rose-100',
    cyan: 'bg-cyan-50/60 border-cyan-100',
    orange: 'bg-orange-50/40 border-orange-100',
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone] || tones.slate}`}>
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 mb-1">{label}</p>
      <p className="text-lg font-bold text-gray-800">{value}</p>
    </div>
  );
}

function BucketHistogram({ title, items }) {
  const total = items.reduce((sum, [, n]) => sum + n, 0);
  const max = Math.max(...items.map(([, n]) => n), 1);
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
      <p className="text-xs font-semibold text-gray-600 mb-3">{title}</p>
      {items.length > 0 ? (
        <div className="space-y-3">
          <div className="h-28 flex items-end gap-2">
            {items.map(([label, n]) => (
              <div key={label} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
                <span className="text-[10px] font-semibold text-gray-600">{n}</span>
                <div className="w-full flex items-end justify-center h-20">
                  <div
                    className="w-full max-w-8 rounded-t-md bg-indigo-400"
                    style={{ height: `${Math.max(8, (n / max) * 100)}%` }}
                    title={`${label}: ${n} (${pct(n, total)}%)`}
                  />
                </div>
                <span className="text-[10px] text-gray-400 truncate w-full text-center" title={label}>{label}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {items.map(([label, n]) => (
              <span key={label} className="text-[10px] text-gray-500 bg-white border border-slate-100 rounded-full px-2 py-0.5">
                {label}: {n} ({pct(n, total)}%)
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-400">Sin datos.</p>
      )}
    </div>
  );
}

function MiniBucket({ title, items, note }) {
  const total = items.reduce((sum, [, n]) => sum + n, 0);
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
      <p className="text-xs font-semibold text-gray-600 mb-2">{title}</p>
      <div className="space-y-1.5">
        {items.length > 0 ? items.map(([label, n]) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 w-20 truncate">{label}</span>
            <div className="flex-1 bg-white rounded-full h-1.5 overflow-hidden">
              <div className="h-full rounded-full bg-indigo-400" style={{ width: `${pct(n, total)}%` }} />
            </div>
            {/* El porcentaje primero (es lo que se compara entre filas) y el
                conteo entre paréntesis. `whitespace-nowrap` + ancho fijo: con
                4 dígitos el texto se partía en dos líneas y desalineaba la fila. */}
            <span className="text-[11px] font-semibold text-gray-700 w-28 text-right whitespace-nowrap tabular-nums">
              {pct(n, total)}% ({Number(n).toLocaleString('es-CL')})
            </span>
          </div>
        )) : (
          <p className="text-xs text-gray-400">Sin datos.</p>
        )}
      </div>
      {note && <p className="text-[10px] text-gray-400 mt-2 pt-2 border-t border-slate-100">{note}</p>}
    </div>
  );
}

// ─── Export functions ─────────────────────────────────────────────────────────
function exportBaseName(fileName) {
  const raw = String(fileName || 'archivo_origen')
    .replace(/\.[^.]+$/, '')
    .trim();
  return (raw || 'archivo_origen')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'archivo_origen';
}

function addOtbbMaestroSheet(wb, masterJson, metaMap, distribution = [], taggedRows = []) {
  const ws = wb.addWorksheet('Data_maestro');
  const header = [
    'Tipo',
    'Tipificación',
    'Industria',
    'Segmento',
    'Origen',
    'Accionable',
    'Tratamiento',
    'Macro Producto',
    'Producto',
    'Módulo Journey',
    'Decision Flow',
    'Caso de Uso',
    'Categoría',
    'Subcategoría',
    'Etapa Comercial',
    'Tipo Interacción',
    'Área Responsable',
    'Adjuntos',
    'Definición',
    'Capacidad Wird',
    'N',
    '%',
    'Ejemplo 1',
    'Ejemplo 2',
    'Ejemplo 3',
    'Ejemplo 4',
    'Ejemplo 5',
  ];
  const hrow = ws.addRow(header);
  hrow.font = { bold: true };
  hrow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
  hrow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  const origenObservado = observedOrigenByCode(taggedRows);

  // El maestro expone lo que fue efectivo en el proceso: recorremos la distribución.
  (distribution || []).forEach(d => {
    const code = d.code;
    const m = metaMap[code] || {};
    const tipo = m.tipo === 'emergente' ? 'Emergente' : m.tipo === 'exclusion' ? 'Exclusión' : 'Catálogo';
    const raw = masterJson[code] || '';
    const defMatch = raw.match(/\[(.+)\]$/s);
    const def = defMatch ? defMatch[1] : '';
    const examples = (d.examples || []).map(e => e.text).slice(0, 5);
    while (examples.length < 5) examples.push('');
    const row = ws.addRow([
      tipo,
      code,
      m.industria || '',
      m.segmento || '',
      m.origen || origenObservado[code] || '',
      m.accionable ? 'Sí' : '',
      m.tratamiento || '',
      m.macroProducto || '',
      m.producto || '',
      m.moduloJourney || '',
      m.decisionFlow || '',
      m.casoUso || '',
      m.categoria || '',
      m.subcategoria || '',
      m.etapaComercial || '',
      m.tipoInteraccion || '',
      m.areaResponsable || '',
      m.adjuntos || '',
      def,
      m.capacidadWird || '',
      d.n || 0,
      d.pct || 0,
      ...examples,
    ]);
    // Destacar visualmente las filas emergentes y de exclusión.
    if (tipo === 'Emergente') {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E8FF' } };
      });
    }
    if (tipo === 'Exclusión') {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } };
      });
    }
  });
  ws.columns.forEach(c => { c.width = 22; });
  return ws;
}

function addDistributionSheet(wb, distribution, sheetName = 'Distribucion', options = {}) {
  const ws = wb.addWorksheet(sheetName);
  const hdr = options.threadMode
    ? ['Tipificación', 'Categoría completa', 'N hilos', '% sobre total de hilos']
    : ['Tipificación', 'Categoría completa', 'N', '% sobre total'];
  const hrow = ws.addRow(hdr);
  hrow.font = { bold: true };
  hrow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
  hrow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  distribution.forEach(d => {
    ws.addRow([d.code, codeCategoryLabel(d), d.n, d.pct]);
  });
  ws.columns = [{ width: 18 }, { width: 42 }, { width: 10 }, { width: 14 }];
  return ws;
}

function addTaggedDataSheet(wb, taggedRows, metaMap, sheetName = 'Datos_etiquetados', options = {}) {
  const ws1 = wb.addWorksheet(sheetName);
  const generatedKeys = new Set([
    'CategoriaAsignada',
    'Confianza',
    'Evidencia',
    'Justificacion',
    'Justificación',
    'Tipo',
    'Accionable',
    'Tratamiento',
    'ReglaExclusion',
    'TipificacionesSecundarias',
    'TagsHilo',
    'Origen',
    'Apertura',
    'Gestion',
    'Desenlace',
    'Derivado',
    'Fricciones',
    'FriccionesNombres',
    'MacroFricciones',
    'EvidenciaFricciones',
    'FriccionIniciaEnHilo',
    'pendiente',
    'abordado',
    'derivado',
    'friccion',
    'DerivacionInterna',
    'Num_derivados',
    'Turn_derivados',
    'email_derivado',
    'SentimentHilo',
    'overall_sentiment_score',
    'n_excluidos_hilo',
    'n_duplicados_archivo_hilo',
    'n_insistencias_hilo',
    'categorias_exclusion_hilo',
  ]);
  const baseKeys = taggedRows.length > 0
    ? Object.keys(taggedRows[0]).filter(k => !generatedKeys.has(k) && !k.startsWith('__'))
    : [];
  const hdr1 = [
    ...baseKeys,
    'Tipificación',
    'Confianza',
    'Evidencia',
    'Justificación',
    ...(options.threadMode ? [
      'Tipificaciones secundarias',
      'Tags por turno',
      'Origen',
      'Tipo apertura',
      'Gestión',
      'Desenlace',
      'Fricciones',
      'Macro-fricciones',
      'Evidencia fricciones',
      'Fricción inicia en hilo',
      'Derivación interna',
      'N° derivaciones',
      'Turno derivación',
      'Email derivación',
      'Sentimiento (modelo)',
      'Score sentimiento',
      'Excluidos (motor)',
      'Duplicados de archivo (motor)',
      'Insistencias (motor)',
      'Categorías de exclusión (motor)',
    ] : []),
    'Categoría',
    'Subcategoría',
    'Sentimiento',
  ];
  const h1row = ws1.addRow(hdr1);
  h1row.font = { bold: true };
  h1row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
  h1row.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  taggedRows.forEach(r => {
    const code = (r.CategoriaAsignada || '').trim();
    const m = metaMap[code] || {};
    ws1.addRow([
      ...baseKeys.map(k => r[k] ?? ''),
      code,
      r.Confianza ?? '',
      r.Evidencia ?? '',
      r.Justificacion ?? r.Justificación ?? '',
      ...(options.threadMode ? [
        r.TipificacionesSecundarias ?? '',
        r.TagsHilo ?? '',
        r.Origen ?? '',
        r.Apertura ?? '',
        r.Gestion ?? '',
        r.Desenlace ?? '',
        r.FriccionesNombres ?? '',
        r.MacroFricciones ?? '',
        r.EvidenciaFricciones ?? '',
        r.FriccionIniciaEnHilo ?? '',
        r.DerivacionInterna ?? '',
        r.Num_derivados ?? '',
        r.Turn_derivados ?? '',
        r.email_derivado ?? '',
        r.SentimentHilo ?? '',
        r.overall_sentiment_score ?? '',
        r.n_excluidos_hilo ?? '',
        r.n_duplicados_archivo_hilo ?? '',
        r.n_insistencias_hilo ?? '',
        r.categorias_exclusion_hilo ?? '',
      ] : []),
      m.categoria || '',
      m.subcategoria || '',
      m.sentimiento || '',
    ]);
  });
  ws1.columns.forEach(c => { c.width = 22; });
  return ws1;
}

function enrichThreadDetailRows(threadDetailRows = [], taggedRows = []) {
  if (!threadDetailRows.length) return [];
  const byThread = new Map(
    (taggedRows || []).map(row => [String(row.thread_id || ''), row])
  );
  const threadFields = [
    'CategoriaAsignada',
    'TipificacionesSecundarias',
    'Confianza',
    'Origen',
    'Apertura',
    'Gestion',
    'Desenlace',
    'Derivado',
    'Fricciones',
    'FriccionesNombres',
    'MacroFricciones',
    'FriccionIniciaEnHilo',
    'JourneyConversacional',
    'DerivacionInterna',
    'Num_derivados',
    'Turn_derivados',
    'email_derivado',
    'SentimentHilo',
    'overall_sentiment_score',
  ];
  return threadDetailRows.map(detail => {
    const parent = byThread.get(String(detail.thread_id || '')) || {};
    const enriched = { ...detail };
    threadFields.forEach(key => {
      if (parent[key] != null && parent[key] !== '') enriched[`conversacion_${key}`] = parent[key];
    });
    // La etiqueta propia del turno: es el nivel unitario, y por eso no se pisa
    // con la categoría principal de la conversación.
    const turno = (parent.__turnos || []).find(t => Number(t.n) === Number(detail.orden_hilo));
    enriched.turno_categoria = turno?.code || enriched.turno_categoria || '';
    enriched.turno_confianza = turno?.confidence ?? enriched.turno_confianza ?? '';
    enriched.turno_evidencia = (turno?.evidence || []).join(' | ') || enriched.turno_evidencia || '';
    const frictionIds = (parent.__fricciones || [])
      .filter(f => Number(f.n) === Number(detail.orden_hilo))
      .map(f => f.id);
    if (!enriched.friccion_inicia_aqui) {
      enriched.friccion_inicia_aqui = frictionIds.length ? 'Sí' : '';
      enriched.friccion_ids_en_este_hilo = frictionIds.join('; ');
    }
    if (!enriched.wmc_code && String(enriched.turno_categoria).startsWith('WMC')) {
      enriched.wmc_code = enriched.turno_categoria;
      enriched.wmc_evidencia = enriched.turno_evidencia;
    }
    return enriched;
  });
}

function addThreadDetailSheet(wb, threadDetailRows = [], taggedRows = []) {
  const rows = enrichThreadDetailRows(threadDetailRows, taggedRows);
  if (!rows.length) return null;
  const ws = wb.addWorksheet('Detalle_hilos');
  const baseKeys = Object.keys(rows[0]).filter(k => !k.startsWith('__'));
  // Orden estable: columnas del detalle + etiqueta del turno + contexto de la
  // conversación + WMC unitario al final si faltan.
  const preferredTail = [
    'turno_categoria',
    'turno_confianza',
    'turno_evidencia',
    'friccion_inicia_aqui',
    'friccion_ids_en_este_hilo',
    'excluido_ruido',
    'categoria_exclusion',
    'regla_id_exclusion',
    'evidencia_exclusion',
    'fila_estado_mensaje',
    'insistencia_n_mensaje',
    'conversacion_FriccionIniciaEnHilo',
    'conversacion_CategoriaAsignada',
    'conversacion_Confianza',
    'conversacion_TipificacionesSecundarias',
    'conversacion_JourneyConversacional',
    'conversacion_Origen',
    'conversacion_Apertura',
    'conversacion_Gestion',
    'conversacion_Desenlace',
    'conversacion_Fricciones',
    'conversacion_MacroFricciones',
    'conversacion_DerivacionInterna',
    'conversacion_Num_derivados',
    'conversacion_Turn_derivados',
    'conversacion_email_derivado',
    'conversacion_SentimentHilo',
    'conversacion_overall_sentiment_score',
    'wmc_code',
    'wmc_evidencia',
    'wmc_tratamiento',
    'wmc_regla',
  ];
  const headers = [
    ...baseKeys.filter(k => !preferredTail.includes(k)),
    ...preferredTail.filter(k => baseKeys.includes(k) || rows.some(r => r[k] != null && r[k] !== '')),
  ];
  const hrow = ws.addRow(headers);
  hrow.font = { bold: true };
  hrow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
  hrow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  rows.forEach(row => {
    ws.addRow(headers.map(k => row[k] ?? ''));
  });
  ws.columns.forEach(c => { c.width = 22; });
  return ws;
}

// Espejo de motor-exclusiones/scripts/salidas_otbb.py `_excluidos.csv`: qué
// se excluyó y por qué, correo por correo, para poder responder "¿por qué
// salió éste?" sin ir a buscarlo en Detalle_hilos. Vacío (hoja no se crea) si
// el motor no corrió sobre este archivo.
function addExclusionesSheet(wb, threadDetailRows = []) {
  const excluded = threadDetailRows.filter(row => row.excluido_ruido === 'True');
  if (!excluded.length) return null;
  const ws = wb.addWorksheet('Excluidos');
  const headers = [
    'thread_id',
    'orden_hilo',
    'fecha_hilo',
    'direccion_hilo',
    'categoria_exclusion',
    'regla_id_exclusion',
    'evidencia_exclusion',
    'fila_estado_mensaje',
    'insistencia_n_mensaje',
    'content_hilo',
  ];
  const hrow = ws.addRow(headers);
  hrow.font = { bold: true };
  hrow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
  hrow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  excluded.forEach(row => {
    ws.addRow(headers.map(k => row[k] ?? ''));
  });
  ws.columns.forEach(c => { c.width = 26; });
  return ws;
}

function addWmcSignalsSheet(wb, threadRows = [], threadDetailRows = []) {
  const summary = summarizeThreadWmcSignals(threadRows, threadDetailRows);
  if (!summary.interactionsWithWmc) return null;

  const ws = wb.addWorksheet('Senales_WMC');
  const headers = [
    'WMC',
    'N hilos WMC',
    '% hilos',
    'N conversaciones',
    '% presencia en conversaciones',
    'Tratamiento',
    'Evidencia ejemplo',
  ];
  const hrow = ws.addRow(headers);
  hrow.font = { bold: true };
  hrow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
  hrow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  summary.byCode.forEach(item => {
    ws.addRow([
      item.code,
      item.n_interacciones,
      item.pct_interacciones,
      item.n_hilos,
      item.pct_hilos,
      item.tratamiento || '',
      item.evidencia || '',
    ]);
  });
  ws.columns.forEach(c => { c.width = 24; });
  return ws;
}

function addFlowConversationSheet(wb, rows = []) {
  const flowRows = rows.filter(row => row.Gestion || row.Desenlace || row.Origen);
  if (!flowRows.length) return null;
  const ws = wb.addWorksheet('Flujo_conversacional');
  const headers = [
    'thread_id',
    'Origen',
    'Tipo apertura',
    'Gestión',
    'Desenlace',
    'Bucket desenlace',
    'Tipo de caída',
    'En base analizable',
    'Conversación neta',
    'Caso comercial activo',
    'Desenlace visible',
    'Journey',
    'Fricciones',
    'Macro-fricciones',
    'Evidencia fricciones',
    'Fricción inicia en hilo',
    'Derivación interna',
    'N° derivaciones',
    'Turno derivación',
    'Email derivación',
    'Sentimiento (modelo)',
    'Score sentimiento',
    'Excluidos (motor)',
    'Duplicados de archivo (motor)',
    'Insistencias (motor)',
    'Categorías de exclusión (motor)',
  ];
  const hrow = ws.addRow(headers);
  hrow.font = { bold: true };
  hrow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
  hrow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  flowRows.forEach(row => {
    const state = conversationFlowState(row);
    ws.addRow([
      row.thread_id ?? '',
      state.origen,
      state.apertura,
      state.gestion,
      state.desenlace,
      BUCKET_LABELS[state.bucket] || state.bucket,
      state.caida ? CAIDA_LABELS[state.caida] : '',
      state.enBase ? 'True' : 'False',
      state.neta ? 'True' : 'False',
      state.casoActivo ? 'True' : 'False',
      state.desenlaceVisible ? 'True' : 'False',
      row.JourneyConversacional ?? '',
      row.FriccionesNombres ?? '',
      row.MacroFricciones ?? '',
      row.EvidenciaFricciones ?? '',
      row.FriccionIniciaEnHilo ?? '',
      row.DerivacionInterna ?? '',
      row.Num_derivados ?? '',
      row.Turn_derivados ?? '',
      row.email_derivado ?? '',
      row.SentimentHilo ?? '',
      row.overall_sentiment_score ?? '',
      row.n_excluidos_hilo ?? '',
      row.n_duplicados_archivo_hilo ?? '',
      row.n_insistencias_hilo ?? '',
      row.categorias_exclusion_hilo ?? '',
    ]);
  });
  ws.columns.forEach(c => { c.width = 26; });
  return ws;
}

function addFunnelSheet(wb, rows = []) {
  const flowRows = rows.filter(row => row.Gestion || row.Desenlace || row.Origen);
  if (!flowRows.length) return null;
  const analytics = getFlowAnalytics(flowRows);
  const ws = wb.addWorksheet('Funnel_gestion');
  const base = analytics.funnel[0]?.n || 0;

  const hrow = ws.addRow(['Compuerta', 'N', '% sobre base analizable']);
  hrow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hrow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
  analytics.funnel.forEach(gate => ws.addRow([gate.label, gate.n, pct(gate.n, base)]));

  ws.addRow([]);
  const bucketHeader = ws.addRow(['Bucket de desenlace', 'N', '% sobre base analizable']);
  bucketHeader.font = { bold: true };
  analytics.desenlaces.porBucket.forEach(([bucket, n]) => ws.addRow([BUCKET_LABELS[bucket] || bucket, n, pct(n, base)]));
  ws.addRow(['Derivación u otro producto (fuera del funnel)', analytics.desenlaces.fuera, '']);

  ws.addRow([]);
  const caidaHeader = ws.addRow(['Caída', 'N', '% sobre base analizable']);
  caidaHeader.font = { bold: true };
  ws.addRow([CAIDA_LABELS.apertura, analytics.caidas.apertura, pct(analytics.caidas.apertura, base)]);
  ws.addRow([CAIDA_LABELS.documental, analytics.caidas.documental, pct(analytics.caidas.documental, base)]);

  ws.addRow([]);
  const journeyHeader = ws.addRow(['Journey', 'N', '% sobre total', 'Ganados', 'Desenlace top', 'Macro-fricción top', 'Tiempo respuesta prom. hrs']);
  journeyHeader.font = { bold: true };
  analytics.journeys.forEach(item => ws.addRow([
    item.journey,
    item.n,
    item.pct,
    item.ganados,
    item.topDesenlace,
    item.topFriccion,
    item.avgResponseHours,
  ]));

  ws.columns.forEach(c => { c.width = 30; });
  return ws;
}

// Arma el mismo workbook que se exporta a Excel, sin disparar la descarga —
// lo reutiliza tanto downloadOtbbDatasetExcel como la subida a otbb-service
// (el reporte PDF se genera sobre este mismo maestro, no sobre un archivo aparte).
function buildOtbbDatasetWorkbook(masterJson, metaMap, distribution = [], taggedRows = [], options = {}) {
  const wb = new ExcelJS.Workbook();
  addOtbbMaestroSheet(wb, masterJson, metaMap, distribution, taggedRows);
  addTaggedDataSheet(wb, taggedRows, metaMap, 'Datos_etiquetados', options);
  addDistributionSheet(wb, distribution, 'Distribucion', options);
  addThreadDetailSheet(wb, options.threadDetailRows || [], taggedRows);
  if (options.threadMode) addExclusionesSheet(wb, options.threadDetailRows || []);
  if (options.threadMode) addWmcSignalsSheet(wb, taggedRows, options.threadDetailRows || []);
  if (options.threadMode) {
    addFlowConversationSheet(wb, taggedRows);
    addFunnelSheet(wb, taggedRows);
  }
  return wb;
}

async function downloadOtbbDatasetExcel(masterJson, metaMap, distribution = [], taggedRows = [], filename = 'maestro_otbb.xlsx', options = {}) {
  const wb = buildOtbbDatasetWorkbook(masterJson, metaMap, distribution, taggedRows, options);
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function OpenBlackBox() {
  const cachedRef = useRef(readOtbbCache());
  const cached = cachedRef.current || {};

  // Config
  const [modelMode, setModelMode]     = useState(cached.modelMode || 'gpt-4.1');
  const [file, setFile]               = useState(null);
  const [cachedFileName, setCachedFileName] = useState(cached.fileName || '');
  // Conteo de filas del archivo, leído al cargarlo. Sale gratis: para .xlsx ya
  // se carga el workbook entero solo para leer la fila de cabeceras, y para
  // .csv Papa ya entrega todas las filas. Sin esto no había forma de saber
  // cuántos registros se iban a procesar hasta que el análisis terminaba.
  const [fileRowCount, setFileRowCount] = useState(null);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [columns, setColumns]         = useState(cached.columns || []);
  const [textColumn, setTextColumn]   = useState(cached.textColumn || '');
  const [analysisUnit, setAnalysisUnit] = useState(cached.analysisUnit || 'message');
  const [threadColumn, setThreadColumn] = useState(cached.threadColumn || '');
  const [threadDateColumn, setThreadDateColumn] = useState(cached.threadDateColumn || '');
  const [threadDirectionColumn, setThreadDirectionColumn] = useState(cached.threadDirectionColumn || '');
  const [threadSubjectColumn, setThreadSubjectColumn] = useState(cached.threadSubjectColumn || '');
  const [threadContentColumn, setThreadContentColumn] = useState(cached.threadContentColumn || '');
  const [threadToColumn, setThreadToColumn] = useState(cached.threadToColumn || '');
  const [threadInternalColumn, setThreadInternalColumn] = useState(cached.threadInternalColumn || '');
  const [threadMaxTags, setThreadMaxTags] = useState(cached.threadMaxTags ?? 3);
  // Ambos parten activados: los servicios corren local y degradan solos si no
  // están arriba. Con el default apagado, el export salía sin columna de
  // sentimiento y parecía que el modelo no estaba conectado.
  const [sentimentEnabled, setSentimentEnabled] = useState(cached.sentimentEnabled ?? true);
  // motor-exclusiones: capa determinista (sin LLM) que marca ruido operativo
  // ANTES de armar transcript_hilo. No confundir con la categoría WMC
  // "Exclusión" (exclusionMaster/exclusionMeta más abajo), que es algo que el
  // LLM asigna después — son dos cosas distintas que comparten nombre en español.
  const [exclusionMotorEnabled, setExclusionMotorEnabled] = useState(cached.exclusionMotorEnabled ?? true);
  // Pre-análisis de exclusiones: va debajo del pre-análisis de conversaciones,
  // antes de cualquier llamada al LLM. 'idle' | 'loading' | 'ready' | 'error'.
  // Por qué la columna de sentimiento quedó vacía, si quedó vacía. Se muestra
  // en pantalla: el fallo es tolerable, pero no puede ser invisible.
  const [sentimentWarning, setSentimentWarning] = useState('');
  const [exclusionPreview, setExclusionPreview] = useState(null);
  const [exclusionPreviewState, setExclusionPreviewState] = useState('idle');
  // Cache de las filas ya enriquecidas por el motor, para que `run()` no
  // vuelva a pedirle lo mismo al servicio si la config no cambió.
  const exclusionCacheRef = useRef({ signature: '', rows: null, resumen: null });

  // Process state
  const [phase, setPhase]             = useState(cached.phase || 0);  // 0=config 1=catálogo 2=levantamiento 3=etiquetado 4=análisis 5=listo
  const [progress, setProgress]       = useState(cached.progress || 0);
  const [error, setError]             = useState('');
  const cancelledRef                  = useRef(false);
  const abortRef                      = useRef(null);

  // Results
  const [masterJson, setMasterJson]         = useState(cached.masterJson || null);
  const [filteredMaster, setFilteredMaster] = useState(cached.filteredMaster || null);
  const [metaMap, setMetaMap]               = useState(cached.metaMap || null);
  const [taggedRows, setTaggedRows]         = useState(cached.taggedRows || null);
  const [distribution, setDistrib]          = useState(cached.distribution || null);
  const [threadDetailRows, setThreadDetailRows] = useState(cached.threadDetailRows || []);
  const [threadSummary, setThreadSummary] = useState(cached.threadSummary || null);
  // Señal detectable por id de fricción: lo único del catálogo que el dashboard
  // necesita, y va al cache para que sobreviva a un reload sin reprocesar.
  const [frictionSignals, setFrictionSignals] = useState(cached.frictionSignals || null);
  // Definiciones del catálogo de flujo por campo y por valor: el tablero las
  // muestra para que cada compuerta y cada bucket se pueda leer contra su origen.
  const [flowDefs, setFlowDefs] = useState(cached.flowDefs || null);

  // Dashboard mode: 'usuario' tiene acceso completo + export; 'cliente' solo la analítica básica
  const [dashMode, setDashMode] = useState('usuario');

  // Flujo post-proceso: 'results' (dashboard + exportación) → 'config' (2ª
  // pantalla: parámetros del reporte PDF vía otbb-service) → vuelta a 'results'
  // con el job de PDF corriendo en segundo plano.
  const [reportView, setReportView] = useState('results');
  const [reportJob, setReportJob] = useState({ status: 'idle', jobId: '', pdfUrl: '', error: '' });

  // WMB: Asistencia IA para "Otros"
  const [wmbEnabled,         setWmbEnabled]         = useState(cached.wmbEnabled ?? false);
  const [wmbIndustria,       setWmbIndustria]       = useState(cached.wmbIndustria || 'Banca');
  const [wmbIndustriaCustom, setWmbIndustriaCustom] = useState(cached.wmbIndustriaCustom || '');
  const [wmbOrigenLabel,     setWmbOrigenLabel]     = useState(cached.wmbOrigenLabel || 'Email');
  const [wmbOrigenCustom,    setWmbOrigenCustom]    = useState(cached.wmbOrigenCustom || '');
  const [wmbNCategories,     setWmbNCategories]     = useState(cached.wmbNCategories ?? 0);

  const WMB_NCAT_OPTIONS = [
    { label: 'Pocas',                    value: 8 },
    { label: 'Suficientes',              value: 15 },
    { label: 'Bastantes',                value: 25 },
    { label: 'Dejar que el modelo decida', value: 0 },
  ];
  const isRunning = phase > 0 && phase < 5;

  useEffect(() => {
    writeOtbbCache({
      modelMode,
      fileName: file?.name || cachedFileName,
      columns,
      textColumn,
      analysisUnit,
      threadColumn,
      threadDateColumn,
      threadDirectionColumn,
      threadSubjectColumn,
      threadContentColumn,
      threadToColumn,
      threadInternalColumn,
      threadMaxTags,
      sentimentEnabled,
      exclusionMotorEnabled,
      phase,
      progress,
      masterJson,
      filteredMaster,
      metaMap,
      taggedRows,
      distribution,
      threadDetailRows,
      threadSummary,
      frictionSignals,
      flowDefs,
      wmbEnabled,
      wmbIndustria,
      wmbIndustriaCustom,
      wmbOrigenLabel,
      wmbOrigenCustom,
      wmbNCategories,
      updatedAt: new Date().toISOString(),
    });
  }, [modelMode, file, cachedFileName, columns, textColumn, analysisUnit, threadColumn, threadDateColumn, threadDirectionColumn, threadSubjectColumn, threadContentColumn, threadToColumn, threadInternalColumn, threadMaxTags, sentimentEnabled, exclusionMotorEnabled, phase, progress, masterJson, filteredMaster, metaMap, taggedRows, distribution, threadDetailRows, threadSummary, wmbEnabled, wmbIndustria, wmbIndustriaCustom, wmbOrigenLabel, wmbOrigenCustom, wmbNCategories]);

  // ── File upload ──────────────────────────────────────────────────────────────
  // El formato y el tamaño los valida `FileDropzone` antes de llamar aquí
  // (ver `validarArchivo` en src/ui/FileDropzone.jsx); esta función solo se
  // ocupa de leer el archivo ya aceptado.
  const handleFileUpload = async (f) => {
    if (!f) return;
    setFile(f);
    setFileRowCount(null);
    setIsParsingFile(true);
    setCachedFileName(f.name);
    setColumns([]);
    setTextColumn('');
    setError('');
    setPhase(0);
    setProgress(0);
    setMasterJson(null);
    setFilteredMaster(null);
    setMetaMap(null);
    setTaggedRows(null);
    setDistrib(null);
    setThreadDetailRows([]);
    setThreadSummary(null);

    try {
      if (f.name.endsWith('.csv')) {
        Papa.parse(f, {
          header: true, skipEmptyLines: true,
          complete: (r) => {
            const cols = Object.keys(r.data[0] || {}).filter(h => h && !h.startsWith('Unnamed'));
            setColumns(cols);
            setTextColumn(inferTextCol(cols));
            applyThreadInference(cols);
            setFileRowCount(r.data.length);
            setIsParsingFile(false);
            if (!cols.length) setError('El archivo no tiene una fila de cabeceras legible en la primera fila.');
          },
          error: () => {
            setIsParsingFile(false);
            setError('No se pudo leer el CSV. Comprueba que esté bien formado y en UTF-8.');
          },
        });
      } else {
        const buf = await f.arrayBuffer();
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
        const ws = wb.worksheets[0];
        const headers = []; ws.getRow(1).eachCell(c => headers.push(String(c.value || '')));
        const cols = headers.filter(h => h && !h.startsWith('Unnamed'));
        setColumns(cols);
        setTextColumn(inferTextCol(cols));
        applyThreadInference(cols);
        setFileRowCount(Math.max((ws.actualRowCount || ws.rowCount || 1) - 1, 0));
        setIsParsingFile(false);
        if (!cols.length) setError('La primera hoja no tiene cabeceras legibles en la primera fila.');
      }
    } catch {
      setIsParsingFile(false);
      setError('No se pudo leer el archivo. Si es un .xlsx, ábrelo y vuelve a guardarlo desde Excel.');
    }
  };

  function inferTextCol(cols) {
    const patterns = ['texto','text','mensaje','body','verbatim','contenido','comentario','message'];
    return cols.find(c => patterns.some(p => c.toLowerCase().includes(p))) || cols[0] || '';
  }

  function applyThreadInference(cols) {
    const inferred = inferThreadColumns(cols);
    setThreadColumn(inferred.threadColumn);
    setThreadDateColumn(inferred.dateColumn);
    setThreadDirectionColumn(inferred.directionColumn);
    setThreadSubjectColumn(inferred.subjectColumn);
    setThreadContentColumn(inferred.contentColumn || inferTextCol(cols));
    setThreadToColumn(inferred.toColumn);
    setThreadInternalColumn(inferred.internalColumn);
  }

  const parseUploadedFile = useCallback(async () => {
    if (!file) return [];
    if (file.name.toLowerCase().endsWith('.csv')) {
      return await new Promise((res, rej) => Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: r => res(r.data),
        error: rej,
      }));
    }
    if (file.name.toLowerCase().endsWith('.xlsx')) {
      const buf = await file.arrayBuffer();
      const wb  = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
      const ws  = wb.worksheets[0];
      const headers = [];
      ws.getRow(1).eachCell(c => headers.push(String(c.value || '')));
      const rows = [];
      ws.eachRow((row, ri) => {
        if (ri === 1) return;
        const r = {};
        row.eachCell({ includeEmpty: true }, (c, ci) => { r[headers[ci - 1]] = String(c.value ?? ''); });
        rows.push(r);
      });
      return rows;
    }
    if (file.name.toLowerCase().endsWith('.xls')) {
      throw new Error('Formato .xls (Excel 97-2003) no soportado. Guarda el archivo como .xlsx e inténtalo de nuevo.');
    }
    throw new Error('Formato de archivo no soportado.');
  }, [file]);

  // Identifica archivo + mapeo de columnas: si no cambió, las filas que ya
  // enriqueció el motor de exclusiones siguen sirviendo y `run()` las reusa.
  const preanalysisSignature = [
    file?.name || cachedFileName, file?.size ?? '', file?.lastModified ?? '',
    threadColumn, threadDateColumn, threadSubjectColumn, threadContentColumn,
    threadInternalColumn,
  ].join('|');

  useEffect(() => {
    let cancelled = false;
    const canBuildPreanalysis = analysisUnit === 'thread'
      && file
      && threadColumn
      && threadDateColumn
      && threadContentColumn
      && !isRunning;

    if (!canBuildPreanalysis) {
      if (analysisUnit !== 'thread') setThreadSummary(null);
      return;
    }

    (async () => {
      try {
        const rawData = await parseUploadedFile();
        if (cancelled) return;
        const built = buildThreadRows(rawData, {
          threadColumn,
          dateColumn: threadDateColumn,
          directionColumn: threadDirectionColumn,
          subjectColumn: threadSubjectColumn,
          contentColumn: threadContentColumn,
          toColumn: threadToColumn,
          internalColumn: threadInternalColumn,
        });
        const summary = summarizeThreadRows(built.threadRows, built.summary);
        if (cancelled) return;
        setThreadSummary(summary);
        setThreadDetailRows(built.detailRows);
        setError('');

        // ── Pre-análisis de exclusiones ────────────────────────────────────
        // Segundo bloque del pre-análisis, sobre el MISMO archivo ya parseado:
        // el motor marca el ruido operativo y se rearman los hilos con esas
        // marcas, para mostrar abajo qué se va a excluir antes de gastar un
        // solo token de LLM. Las filas enriquecidas quedan en cache para que
        // `run()` no le vuelva a pedir lo mismo al servicio.
        if (!exclusionMotorEnabled) {
          setExclusionPreview(null);
          setExclusionPreviewState('idle');
          return;
        }
        setExclusionPreviewState('loading');
        try {
          // Sobre un archivo real el motor tarda decenas de segundos: no se le
          // vuelve a pedir lo mismo si el archivo y las columnas que sí usa no
          // cambiaron (cambiar "dirección" o "destinatario" no lo afecta), y se
          // espera un momento antes de disparar para no encadenar una llamada
          // por cada cambio de dropdown.
          const cache = exclusionCacheRef.current;
          let motorResult;
          if (cache.rows && cache.signature === preanalysisSignature) {
            motorResult = { rows: cache.rows, resumen: cache.resumen, applied: true };
          } else {
            await new Promise(r => setTimeout(r, 700));
            if (cancelled) return;
            const { messageIdColumn, fromColumn } = inferThreadColumns(Object.keys(rawData[0] || {}));
            motorResult = await runExclusionMotor(rawData, {
              threadColumn,
              dateColumn: threadDateColumn,
              subjectColumn: threadSubjectColumn,
              contentColumn: threadContentColumn,
              messageIdColumn,
              fromColumn,
            }, {});
          }
          if (cancelled) return;
          if (!motorResult.applied) {
            setExclusionPreview(null);
            setExclusionPreviewState('idle');
            return;
          }
          const builtConExclusiones = buildThreadRows(motorResult.rows, {
            threadColumn,
            dateColumn: threadDateColumn,
            directionColumn: threadDirectionColumn,
            subjectColumn: threadSubjectColumn,
            contentColumn: threadContentColumn,
            toColumn: threadToColumn,
            internalColumn: threadInternalColumn,
          });
          if (cancelled) return;
          exclusionCacheRef.current = {
            signature: preanalysisSignature,
            rows: motorResult.rows,
            resumen: motorResult.resumen,
          };
          // Los detalles del pre-análisis pasan a ser los que ya traen las
          // marcas del motor: si se exporta sin correr el análisis completo,
          // el archivo sale con las columnas de exclusión pobladas igual.
          setThreadDetailRows(builtConExclusiones.detailRows);
          setExclusionPreview(summarizeExclusionCheckpoint({
            rawData: motorResult.rows,
            columns,
            threadRows: builtConExclusiones.threadRows,
            detailRows: builtConExclusiones.detailRows,
            resumen: motorResult.resumen,
          }));
          setExclusionPreviewState('ready');
        } catch (e) {
          if (cancelled) return;
          // El motor es aditivo: si no está disponible, el pre-análisis de
          // conversaciones de arriba sigue siendo válido.
          setExclusionPreview(null);
          setExclusionPreviewState('error');
          console.warn('Pre-análisis de exclusiones no disponible:', e.message);
        }
      } catch (e) {
        if (!cancelled) {
          setThreadSummary(null);
          setError(`Error en pre-análisis de conversaciones: ${e.message}`);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [analysisUnit, file, threadColumn, threadDateColumn, threadDirectionColumn, threadSubjectColumn, threadContentColumn, threadToColumn, threadInternalColumn, parseUploadedFile, isRunning, exclusionMotorEnabled, columns, preanalysisSignature]);

  // ── Run full pipeline ────────────────────────────────────────────────────────
  const run = useCallback(async () => {
    const isThreadMode = analysisUnit === 'thread';
    if (!file) { setError('Sube un archivo.'); return; }
    if (!isThreadMode && !textColumn) { setError('Selecciona una columna de texto.'); return; }
    if (isThreadMode && (!threadColumn || !threadDateColumn || !threadContentColumn)) {
      setError('Para modo conversación selecciona columnas de ID de conversación, fecha y contenido.');
      return;
    }
    setError('');
    setSentimentWarning('');
    setReportView('results');
    setReportJob({ status: 'idle', jobId: '', pdfUrl: '', error: '' });
    cancelledRef.current = false;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    // ── Phase 1: fetch catalogs ────────────────────────────────────────────────
    setPhase(1); setProgress(0);
    let master, meta, exclusionMaster = {}, exclusionMeta = {};
    let activeTaxonomy = { flow: null, frictions: null };
    let currentFrictionSignals = null;
    let currentFlowDefs = null;
    try {
      const [{ data: bancaData }, { data: exclusionData }, { data: flowData }, { data: frictionData }] = await Promise.all([
        axios.get(`${API_BASE}/api/catalog/banca-master`, { signal }),
        axios.get(`${API_BASE}/api/catalog/exclusiones`, { signal }),
        axios.get(`${API_BASE}/api/catalog/flujo`, { signal }),
        axios.get(`${API_BASE}/api/catalog/fricciones`, { signal }),
      ]);
      master = bancaData.masterJson;
      meta   = bancaData.metaMap;
      exclusionMaster = exclusionData.masterJson || {};
      exclusionMeta   = exclusionData.metaMap || {};
      activeTaxonomy = { flow: flowData, frictions: frictionData };
      currentFrictionSignals = Object.fromEntries(
        (frictionData.fricciones || []).map(f => [f.id, f.senal])
      );
      currentFlowDefs = flowDefinitionIndex(flowData);
      setFrictionSignals(currentFrictionSignals);
      setFlowDefs(currentFlowDefs);
      setMasterJson({ ...master, ...exclusionMaster });
      setMetaMap({ ...meta, ...exclusionMeta });
    } catch (e) {
      if (isAbortError(e)) { setPhase(0); return; }
      setError(`Error cargando catálogos: ${e.message}`);
      setPhase(0); return;
    }

    // ── Parsear archivo ────────────────────────────────────────────────────────
    let rawData = [];
    try {
      rawData = await parseUploadedFile();
    } catch (e) {
      if (isAbortError(e)) { setPhase(0); return; }
      setError(`Error leyendo archivo: ${e.message}`);
      setPhase(0); return;
    }

    let analysisRows = rawData;
    let analysisTextColumn = textColumn;
    let currentThreadDetails = [];
    let currentThreadSummary = null;

    // ── Phase 1.7 (opcional): motor-exclusiones sobre el archivo crudo ────────
    // Primera interacción con el dataset, antes de threading.js: marca ruido
    // operativo (fuera de oficina, rebotes, banners institucionales, filas
    // repetidas, insistencia) mensaje por mensaje, sobre las mismas columnas
    // que threading.js ya usa para armar el hilo. Es aditivo — nunca borra ni
    // reordena filas de `rawData` — así que si el servicio no está configurado
    // o falla, threading.js recibe `rawData` sin tocar y arma transcript_hilo
    // exactamente como antes (ver exclusionOf() en threading.js).
    // No confundir con exclusionMaster/exclusionMeta (Phase 1, arriba): eso es
    // la categoría WMC "Exclusión" que asigna el LLM después de etiquetar;
    // esto es una capa determinista, sin LLM, que corre antes.
    if (isThreadMode && exclusionMotorEnabled && rawData.length > 0) {
      setPhase(1.7); setProgress(0);
      // El pre-análisis ya le pidió esto mismo al motor, sobre el mismo archivo
      // y la misma config: reusarlo evita una segunda pasada completa por el
      // servicio sin cambiar en nada el resultado.
      const cache = exclusionCacheRef.current;
      const cacheSirve = cache.rows
        && cache.signature === preanalysisSignature
        && cache.rows.length === rawData.length;

      if (cacheSirve) {
        rawData = cache.rows;
        setProgress(100);
      } else {
        try {
          const { messageIdColumn, fromColumn } = inferThreadColumns(Object.keys(rawData[0] || {}));
          const motorResult = await runExclusionMotor(rawData, {
            threadColumn,
            dateColumn: threadDateColumn,
            subjectColumn: threadSubjectColumn,
            contentColumn: threadContentColumn,
            messageIdColumn,
            fromColumn,
          }, {
            setProgress,
            isCancelled: () => cancelledRef.current,
            signal,
          });
          if (cancelledRef.current) { setPhase(0); return; }
          rawData = motorResult.rows;
          if (motorResult.applied) {
            exclusionCacheRef.current = {
              signature: preanalysisSignature,
              rows: motorResult.rows,
              resumen: motorResult.resumen,
            };
          }
        } catch (e) {
          if (e.message === 'CANCELLED' || isAbortError(e)) { setPhase(0); return; }
          // El motor de exclusiones es aditivo: si falla, seguimos con el
          // archivo crudo (mismo patrón que WMB/sentimiento más abajo).
          console.warn('motor-exclusiones falló, continuando sin marcar ruido:', e.message);
        }
      }
    }

    if (isThreadMode) {
      try {
        const built = buildThreadRows(rawData, {
          threadColumn,
          dateColumn: threadDateColumn,
          directionColumn: threadDirectionColumn,
          subjectColumn: threadSubjectColumn,
          contentColumn: threadContentColumn,
          toColumn: threadToColumn,
          internalColumn: threadInternalColumn,
        });
        analysisRows = built.threadRows;
        analysisTextColumn = 'transcript_hilo';
        currentThreadDetails = built.detailRows;
        currentThreadSummary = summarizeThreadRows(analysisRows, built.summary);
        setThreadDetailRows(currentThreadDetails);
        setThreadSummary(currentThreadSummary);
      } catch (e) {
        setError(`Error construyendo conversaciones: ${e.message}`);
        setPhase(0); return;
      }
    } else {
      setThreadDetailRows([]);
      setThreadSummary(null);
    }

    const processRows = analysisRows.map((row, index) => ({ ...row, __otbbRowIndex: index }));

    // ── Phase 2: levantamiento real (GPT clusters + Claude mapping) ───────────
    setPhase(2); setProgress(0);
    let activeMaster = master;
    try {
      const sampleTexts = processRows
        .map(r => String(r[analysisTextColumn] || '').trim())
        .filter(t => t.length > 0);
      if (sampleTexts.length > 0) {
        const mappedMaster = await generateCatalogMappedMaster({
          texts: sampleTexts,
          masterJson: master,
          metaMap: meta,
          companyType: 'Banca',
          setProgress,
          isCancelled: () => cancelledRef.current,
          signal,
        });
        activeMaster = mappedMaster.masterJson;
      } else {
        activeMaster = {};
        setProgress(100);
      }
      setFilteredMaster({ ...activeMaster, ...exclusionMaster });
    } catch (e) {
      if (e.message === 'CANCELLED' || isAbortError(e)) { setPhase(0); return; }
      setError(`Error levantando maestro OTBB: ${e.message}`);
      setPhase(0); return;
    }

    // ── Phase 3: GPT etiqueta todos los mensajes ──────────────────────────────
    setPhase(3); setProgress(0);
    const taggingMaster = { ...activeMaster, ...exclusionMaster };
    let rows;
    try {
      rows = processRows.length > 0
        ? (isThreadMode
            ? await runBlackBoxThreadEtiquetado(
                processRows, analysisTextColumn, taggingMaster, modelMode, threadMaxTags,
                setProgress, () => cancelledRef.current, signal, activeTaxonomy
              )
            : await runBlackBoxEtiquetado(
                processRows, analysisTextColumn, taggingMaster, modelMode,
                setProgress, () => cancelledRef.current, signal
              ))
        : [];
      if (cancelledRef.current) { setPhase(0); return; }
      setTaggedRows(rows);
    } catch (e) {
      if (e.message === 'CANCELLED' || isAbortError(e)) { setPhase(0); return; }
      setError(`Error en etiquetado: ${e.message}`);
      setPhase(0); return;
    }

    // ── Phase 3b (opcional): Levantamiento de Otros (WMB) ────────────────────
    let finalMeta = meta;
    let finalMaster = activeMaster;
    if (wmbEnabled && rows.length > 0) {
      setPhase(3.5); setProgress(0);
      try {
        const otrosTexts = rows
          .filter(r => (r.CategoriaAsignada || '').trim() === 'WMA000')
          .map(r => String(r[analysisTextColumn] || '').trim())
          .filter(Boolean);

        if (otrosTexts.length > 0) {
          const companyType = wmbIndustria === 'Otro' ? wmbIndustriaCustom || 'empresa' : wmbIndustria;
          const medium      = wmbOrigenLabel === 'RRSS' ? 'RRSS' : 'CORREO';

          const { masterJson: wmbMaster, metaMap: wmbMeta } = await generateEmergentCategories({
            texts: otrosTexts,
            companyType,
            medium,
            nCategories: wmbNCategories,
            setProgress,
            isCancelled: () => cancelledRef.current,
            signal,
          });

          if (cancelledRef.current) { setPhase(0); return; }

          // Combinar WMA + WMB en master y metaMap
          finalMaster = { ...activeMaster, ...wmbMaster };
          finalMeta   = { ...meta, ...wmbMeta };

          // Re-etiquetar WMA000 con los nuevos códigos WMB
          const wmbSignal = abortRef.current?.signal;
          const wmbRows = rows.filter(r => (r.CategoriaAsignada || '').trim() === 'WMA000');
          const nonWmbRows = rows.filter(r => (r.CategoriaAsignada || '').trim() !== 'WMA000');

          let retagged;
          try {
            retagged = isThreadMode
              ? await runBlackBoxThreadEtiquetado(
                  wmbRows, analysisTextColumn, { ...wmbMaster, ...exclusionMaster, WMA000: 'Otros (hilo poco representativo, aislado o sin encaje claro en categorías emergentes)' }, modelMode, threadMaxTags,
                  () => {}, () => cancelledRef.current, wmbSignal, activeTaxonomy
                )
              : await runBlackBoxEtiquetado(
                  wmbRows, analysisTextColumn, { ...wmbMaster, ...exclusionMaster, WMA000: 'Otros (mensaje poco representativo, aislado o sin encaje claro en categorías emergentes)' }, modelMode,
                  () => {}, () => cancelledRef.current, wmbSignal
                );
          } catch {
            retagged = wmbRows; // si falla el re-etiquetado, se quedan como WMA000
          }

          // Reconstruir rows completo manteniendo el orden original
          let wi = 0; let ni = 0;
          rows = rows.map(r => {
            if ((r.CategoriaAsignada || '').trim() === 'WMA000') return retagged[wi++] || r;
            return nonWmbRows[ni++] || r;
          });

          setFilteredMaster({ ...finalMaster, ...exclusionMaster });
          setMetaMap(finalMeta);
          setTaggedRows(rows);
        }
      } catch (e) {
        if (e.message === 'CANCELLED' || isAbortError(e)) { setPhase(0); return; }
        // Si el sub-flujo WMB falla, continuamos sin él (no bloqueamos el resultado principal).
        console.warn('Levantamiento WMB falló, continuando sin categorías emergentes:', e.message);
      }
    }

    finalMaster = { ...finalMaster, ...exclusionMaster };
    finalMeta   = { ...finalMeta, ...exclusionMeta };
    if (finalMaster.WMA000 && !finalMeta.WMA000) {
      finalMeta.WMA000 = {
        categoria: 'Otros',
        subcategoria: 'Sin categoría representativa',
        tipo: 'catalogo',
      };
    }
    // El journey y la llave de negocio salen del catálogo, no de una segunda
    // pasada del modelo. Segmento y producto son la llave del zoom del dashboard.
    if (isThreadMode) {
      const annotated = finalizeThreadAnnotations(rows, currentThreadDetails, finalMeta);
      rows = annotated.taggedRows.map(row => {
        const rowMeta = finalMeta[String(row.CategoriaAsignada || '').trim()] || {};
        return {
          ...row,
          JourneyConversacional: isWmcCode(String(row.CategoriaAsignada || '').trim())
            ? ''
            : (rowMeta.journey || rowMeta.moduloJourney || SIN_JOURNEY),
          SegmentoNegocio: rowMeta.segmento || SIN_SEGMENTO,
          ProductoNegocio: rowMeta.producto || SIN_PRODUCTO,
        };
      });
      currentThreadDetails = annotated.detailRows;
      setThreadDetailRows(currentThreadDetails);
    }

    // ── Phase 3.7 (opcional): sentimiento por hilo vía sentiment-model ────────
    if (isThreadMode && sentimentEnabled && rows.length > 0) {
      setPhase(3.7); setProgress(0);
      try {
        const sentimentByThread = await analyzeThreadSentiment(currentThreadDetails, {
          setProgress,
          isCancelled: () => cancelledRef.current,
          signal,
        });
        if (cancelledRef.current) { setPhase(0); return; }
        rows = rows.map(row => ({
          ...row,
          ...(sentimentByThread.get(String(row.thread_id || '')) || { SentimentHilo: '', overall_sentiment_score: '' }),
        }));
      } catch (e) {
        if (e.message === 'CANCELLED' || isAbortError(e)) { setPhase(0); return; }
        // El sentimiento es aditivo: si sentiment-model falla, la corrida sigue.
        // Pero NO en silencio: con solo un console.warn, el fallo se descubría
        // recién al abrir el Excel y encontrar la columna vacía, sin saber por qué.
        const detalle = e.response?.data?.error
          || (e.response?.status ? `el servicio respondió ${e.response.status}` : e.message);
        setSentimentWarning(
          `El análisis de sentimiento no se pudo completar (${detalle}). `
          + 'Las columnas "Sentimiento (modelo)" y "Score sentimiento" quedan vacías; '
          + 'el resto del análisis no se ve afectado.'
        );
        console.warn('Análisis de sentimiento falló, continuando sin él:', e);
      }
    } else if (isThreadMode && !sentimentEnabled && rows.length > 0) {
      // Distinguir "falló" de "estaba apagado": las dos cosas dejan la columna
      // vacía, y sin decirlo se leen igual desde el Excel.
      setSentimentWarning(
        'El análisis de sentimiento estaba desactivado en esta corrida, así que '
        + 'las columnas "Sentimiento (modelo)" y "Score sentimiento" salen vacías. '
        + 'Actívalo en "Parámetros de conversación" y vuelve a ejecutar.'
      );
    }

    setFilteredMaster(finalMaster);
    setMetaMap(finalMeta);
    setTaggedRows(rows);

    // ── Phase 4: distribution ──────────────────────────────────────────────────
    setPhase(4);
    const dist = isThreadMode
      ? buildHiloMultiCoverageDistribution(rows, currentThreadDetails, finalMeta, analysisTextColumn, finalMaster)
      : buildDistribution(rows, finalMeta, analysisTextColumn, finalMaster, { multiTag: false });
    const finalThreadSummary = isThreadMode
      ? {
          ...summarizeThreadRows(rows, currentThreadSummary || {}),
          wmcSignals: summarizeThreadWmcSignals(rows, currentThreadDetails),
        }
      : null;
    setDistrib(dist);
    setThreadSummary(finalThreadSummary);
    writeOtbbCache({
      modelMode,
      fileName: file?.name || cachedFileName,
      columns,
      textColumn,
      analysisUnit,
      threadColumn,
      threadDateColumn,
      threadDirectionColumn,
      threadSubjectColumn,
      threadContentColumn,
      threadToColumn,
      threadInternalColumn,
      threadMaxTags,
      sentimentEnabled,
      phase: 5,
      progress: 100,
      masterJson: { ...master, ...exclusionMaster },
      filteredMaster: finalMaster,
      metaMap: finalMeta,
      taggedRows: rows,
      distribution: dist,
      threadDetailRows: currentThreadDetails,
      threadSummary: finalThreadSummary,
      frictionSignals: currentFrictionSignals,
      flowDefs: currentFlowDefs,
      wmbEnabled,
      wmbIndustria,
      wmbIndustriaCustom,
      wmbOrigenLabel,
      wmbOrigenCustom,
      wmbNCategories,
      updatedAt: new Date().toISOString(),
    });

    setPhase(5);
  }, [file, textColumn, analysisUnit, threadColumn, threadDateColumn, threadDirectionColumn, threadSubjectColumn, threadContentColumn, threadToColumn, threadInternalColumn, threadMaxTags, sentimentEnabled, exclusionMotorEnabled, preanalysisSignature, modelMode, cachedFileName, columns, parseUploadedFile, wmbEnabled, wmbIndustria, wmbIndustriaCustom, wmbOrigenLabel, wmbOrigenCustom, wmbNCategories]);

  const reset = () => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    writeOtbbCache(null);
    setPhase(0); setProgress(0); setError('');
    setFile(null); setCachedFileName(''); setColumns([]); setTextColumn('');
    setFileRowCount(null); setIsParsingFile(false);
    setThreadColumn(''); setThreadDateColumn(''); setThreadDirectionColumn(''); setThreadSubjectColumn(''); setThreadContentColumn(''); setThreadToColumn('');
    setMasterJson(null); setFilteredMaster(null); setMetaMap(null); setTaggedRows(null); setDistrib(null); setThreadDetailRows([]); setThreadSummary(null); setFrictionSignals(null); setFlowDefs(null);
    setReportView('results'); setReportJob({ status: 'idle', jobId: '', pdfUrl: '', error: '' });
    setExclusionPreview(null); setExclusionPreviewState('idle'); setSentimentWarning('');
    exclusionCacheRef.current = { signature: '', rows: null, resumen: null };
    // No reseteamos la config WMB (toggle + industria/origen) — es preferencia del usuario.
  };

  // Crea el job en otbb-service y sondea el PDF; vuelve a la pantalla de
  // resultados de inmediato, el estado del job se muestra ahí (no bloquea).
  const handleCreateReportJob = async (reportConfig) => {
    setReportView('results');
    setReportJob({ status: 'creating', jobId: '', pdfUrl: '', error: '' });
    try {
      const { job_id: jobId } = await createOtbbReportJob(reportConfig);
      const startedAt = Date.now();
      setReportJob({ status: 'polling', jobId, pdfUrl: '', error: '', elapsedS: 0 });
      const pdfBlob = await pollOtbbReportPdf(jobId, {
        // La redacción completa tarda varios minutos: sin un contador el botón
        // parece colgado y se termina cancelando un job que iba bien.
        onProgress: () => setReportJob(prev => (
          prev.status === 'polling'
            ? { ...prev, elapsedS: Math.round((Date.now() - startedAt) / 1000) }
            : prev
        )),
      });
      const pdfUrl = URL.createObjectURL(pdfBlob);
      setReportJob({ status: 'ready', jobId, pdfUrl, error: '' });
    } catch (e) {
      setReportJob(prev => ({ ...prev, status: 'error', error: e.response?.data?.error || e.message || 'No se pudo generar el reporte PDF.' }));
    }
  };

  const cancel = () => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase(0);
    setProgress(0);
    setError('Proceso cancelado.');
  };

  const sourceBaseName = exportBaseName(file?.name || cachedFileName);
  const isThreadMode = analysisUnit === 'thread';
  const canRun = Boolean(file && (isThreadMode
    ? (threadColumn && threadDateColumn && threadContentColumn)
    : textColumn));
  const distributionTextColumn = isThreadMode ? 'transcript_hilo' : textColumn;
  const principalDistribution = taggedRows && metaMap
    ? buildDistribution(
        taggedRows,
        metaMap,
        distributionTextColumn,
        filteredMaster || masterJson || {},
        { multiTag: false, threadUnit: isThreadMode, countLabel: isThreadMode ? 'conversaciones' : 'msgs' }
      )
    : [];
  // Multi-categoría: cobertura sobre hilos (mensajes), no sobre conversaciones.
  const multiCoverageDistribution = isThreadMode && taggedRows && metaMap
    ? buildHiloMultiCoverageDistribution(
        taggedRows,
        threadDetailRows,
        metaMap,
        distributionTextColumn,
        filteredMaster || masterJson || {}
      )
    : (distribution || []);
  const exclusionDistribution = exclusionDistributionForAnalytics(
    isThreadMode ? multiCoverageDistribution : (distribution || [])
  );
  // Analítica de negocio sobre categoría principal (+ residual para cerrar 100%).
  const businessDistribution = businessDistributionForAnalytics(
    isThreadMode ? principalDistribution : (distribution || [])
  );
  const flowRowsForUi = isThreadMode
    ? (taggedRows || []).filter(row => row.Gestion || row.Desenlace || row.Origen)
    : [];
  // Edición inline de metaMap (categoria / subcategoria) desde la tabla de resultados.
  const handleEditMeta = useCallback((code, field, value) => {
    setMetaMap(prev => {
      const updated = { ...prev, [code]: { ...(prev[code] || {}), [field]: value } };
      // Recalcular distribución con los nuevos labels
      setDistrib(dist => dist
        ? dist.map(d => d.code === code ? { ...d, [field]: value } : d)
        : dist
      );
      return updated;
    });
  }, []);

  // ─── RENDER ─────────────────────────────────────────────────────────────────
  const otbbSelectClass = 'w-full text-sm border border-line rounded-xl px-3 py-2 focus:outline-none focus:border-navy/30 focus:ring-2 focus:ring-accent/20 bg-white text-ink';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-ink">Open The Black Box</h2>
          <p className="text-sm text-ink-muted mt-0.5">
            Construye un maestro de tipificaciones desde el catálogo Banca y etiqueta tu muestra automáticamente.
          </p>
        </div>
        {(file || cachedFileName || taggedRows || phase > 0) && (
          <button onClick={reset}
            className="shrink-0 px-3.5 py-1.5 rounded-xl border border-line bg-surface text-ink hover:bg-canvas text-sm font-medium transition-colors">
            Empezar de nuevo
          </button>
        )}
      </div>

      {/* Config card */}
      <div className="bg-surface border border-line rounded-panel shadow-panel p-5 space-y-5">
        <h3 className="font-semibold text-ink text-sm">Configuración</h3>

        <div className="rounded-panel border border-line bg-canvas/60 p-4">
          <label className="block text-xs font-medium text-ink-muted mb-2">Módulo de procesamiento</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              {
                value: 'message',
                label: 'Hilo suelto',
                desc: 'Clasifica cada registro como una unidad independiente.',
              },
              {
                value: 'thread',
                label: 'Conversación',
                desc: 'Agrupa los hilos por ID de conversación y clasifica el caso completo.',
              },
            ].map(option => {
              const selected = analysisUnit === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={isRunning}
                  onClick={() => setAnalysisUnit(option.value)}
                  className={`text-left rounded-xl border px-4 py-3 transition-colors ${
                    selected
                      ? 'border-accent bg-navy text-surface shadow-sm'
                      : 'border-line bg-white text-ink hover:bg-canvas'
                  } ${isRunning ? 'opacity-60 cursor-not-allowed' : ''}`}>
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className={`block text-xs mt-0.5 ${selected ? 'text-white/65' : 'text-ink-muted'}`}>
                    {option.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Mode-specific params */}
        <div className="rounded-panel border border-line bg-white p-4 space-y-4">
          {analysisUnit === 'message' && (
            <>
              <div>
                <p className="text-sm font-semibold text-ink">Parámetros de hilo suelto</p>
                <p className="text-xs text-ink-muted mt-0.5">
                  Usa una columna de texto como unidad base para levantar el maestro y etiquetar.
                </p>
              </div>
              {columns.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">Columna de texto del hilo</label>
                    <select value={textColumn} onChange={e => setTextColumn(e.target.value)} disabled={isRunning}
                      className={otbbSelectClass}>
                      <option value="">— seleccionar —</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-ink-muted">Sube un archivo para seleccionar la columna de texto del hilo.</p>
              )}
            </>
          )}

          {analysisUnit === 'thread' && (
            <>
              <div>
                <p className="text-sm font-semibold text-ink">Parámetros de conversación</p>
                <p className="text-xs text-ink-muted mt-0.5">
                  Agrupa los hilos por conversación, los ordena por fecha y analiza el caso como unidad de negocio.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">Máximo de categorías por conversación</label>
                  <select value={threadMaxTags} onChange={e => setThreadMaxTags(Number(e.target.value))} disabled={isRunning}
                    className={otbbSelectClass}>
                    {THREAD_TAG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">Análisis de sentimiento</label>
                  <div className="flex items-center gap-2 h-9">
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => setSentimentEnabled(v => !v)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors
                        ${sentimentEnabled ? 'bg-accent' : 'bg-line'} ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform
                        ${sentimentEnabled ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                    <span className="text-xs text-ink-muted">
                      {sentimentEnabled ? 'Activado' : 'Desactivado'}
                    </span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">Análisis de exclusiones</label>
                  <div className="flex items-center gap-2 h-9">
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => setExclusionMotorEnabled(v => !v)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors
                        ${exclusionMotorEnabled ? 'bg-accent' : 'bg-line'} ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform
                        ${exclusionMotorEnabled ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                    <span className="text-xs text-ink-muted">
                      {exclusionMotorEnabled ? 'Activado' : 'Desactivado'}
                    </span>
                  </div>
                </div>
              </div>

              {columns.length === 0 ? (
                <p className="text-xs text-ink-muted">
                  Sube un archivo para mapear el ID de conversación, fecha, dirección, subject y contenido.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-7 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">ID de conversación</label>
                    <select value={threadColumn} onChange={e => setThreadColumn(e.target.value)} disabled={isRunning}
                      className={otbbSelectClass}>
                      <option value="">— seleccionar —</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">fecha/timestamp</label>
                    <select value={threadDateColumn} onChange={e => setThreadDateColumn(e.target.value)} disabled={isRunning}
                      className={otbbSelectClass}>
                      <option value="">— seleccionar —</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">dirección</label>
                    <select value={threadDirectionColumn} onChange={e => setThreadDirectionColumn(e.target.value)} disabled={isRunning}
                      className={otbbSelectClass}>
                      <option value="">— opcional —</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">subject</label>
                    <select value={threadSubjectColumn} onChange={e => setThreadSubjectColumn(e.target.value)} disabled={isRunning}
                      className={otbbSelectClass}>
                      <option value="">— opcional —</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">content/body</label>
                    <select value={threadContentColumn} onChange={e => setThreadContentColumn(e.target.value)} disabled={isRunning}
                      className={otbbSelectClass}>
                      <option value="">— seleccionar —</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">destinatario (derivación)</label>
                    <select value={threadToColumn} onChange={e => setThreadToColumn(e.target.value)} disabled={isRunning}
                      className={otbbSelectClass}>
                      <option value="">— opcional —</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">interno (Is Internal)</label>
                    <select value={threadInternalColumn} onChange={e => setThreadInternalColumn(e.target.value)} disabled={isRunning}
                      className={otbbSelectClass}>
                      <option value="">— opcional —</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {analysisUnit === 'thread' && (
          <ThreadPreanalysisPanel summary={threadSummary} />
        )}

        {analysisUnit === 'thread' && threadSummary && (
          <ExclusionPreanalysisPanel data={exclusionPreview} state={exclusionPreviewState} />
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1">Base de conocimiento</label>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-navy/5 border border-line text-sm text-ink font-medium">
              <span className="w-2 h-2 rounded-full bg-accent shrink-0" />
              Banca — Crédito
            </div>
            <p className="text-[10px] text-ink-muted mt-1">OTBB levantará un maestro aplicable desde la muestra</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1">Modelo de etiquetado</label>
            <select value={modelMode} onChange={e => setModelMode(e.target.value)} disabled={isRunning}
              className={otbbSelectClass}>
              {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1">Archivo de datos</label>
            <FileDropzone
              accept=".csv,.xlsx"
              maxMB={MAX_DATOS_MB}
              hint={isThreadMode ? '1 fila = 1 mensaje del hilo' : '1 fila = 1 mensaje'}
              file={file}
              fileName={cachedFileName}
              detail={fileRowCount != null ? `${fileRowCount.toLocaleString('es-CL')} filas` : ''}
              parsing={isParsingFile}
              disabled={isRunning}
              onFile={handleFileUpload}
              onReject={setError}
              error={Boolean(error) && !file}
            />
          </div>
        </div>

        {/* WMB: Asistencia IA para "Otros" */}
        <div className={`rounded-panel border transition-colors p-4 ${wmbEnabled ? 'border-accent/40 bg-accent/10' : 'border-line bg-canvas/50'}`}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">Asistencia IA para "Otros"</p>
              <p className="text-xs text-ink-muted mt-0.5">
                Detecta temáticas emergentes en mensajes no clasificados y los re-etiqueta con códigos WMB.
              </p>
            </div>
            <button
              disabled={isRunning}
              onClick={() => setWmbEnabled(v => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors
                ${wmbEnabled ? 'bg-accent' : 'bg-line'} ${isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform
                ${wmbEnabled ? 'translate-x-4' : 'translate-x-1'}`} />
            </button>
          </div>

          {wmbEnabled && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Industria</label>
                <select
                  value={wmbIndustria} onChange={e => setWmbIndustria(e.target.value)}
                  disabled={isRunning}
                  className={otbbSelectClass}>
                  {WMB_INDUSTRIA_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                {wmbIndustria === 'Otro' && (
                  <input
                    type="text" value={wmbIndustriaCustom}
                    onChange={e => setWmbIndustriaCustom(e.target.value)}
                    placeholder="Nombre de la industria..."
                    disabled={isRunning}
                    className={`mt-2 ${otbbSelectClass}`} />
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Origen de los mensajes</label>
                <select
                  value={wmbOrigenLabel} onChange={e => setWmbOrigenLabel(e.target.value)}
                  disabled={isRunning}
                  className={otbbSelectClass}>
                  {WMB_ORIGEN_OPTIONS.map(o => <option key={o.label} value={o.label}>{o.label}</option>)}
                </select>
                {wmbOrigenLabel === 'Otro' && (
                  <input
                    type="text" value={wmbOrigenCustom}
                    onChange={e => setWmbOrigenCustom(e.target.value)}
                    placeholder="Describe el origen..."
                    disabled={isRunning}
                    className={`mt-2 ${otbbSelectClass}`} />
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Cantidad de categorías</label>
                <select
                  value={wmbNCategories}
                  onChange={e => setWmbNCategories(Number(e.target.value))}
                  disabled={isRunning}
                  className={otbbSelectClass}>
                  {WMB_NCAT_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}{o.value > 0 ? ` — ${o.value} categorías` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Qué va a pasar al ejecutar — antes de gastar un token */}
        {!isRunning && phase === 0 && fileRowCount != null && (
          <FilePreflight
            stats={[
              { label: 'filas leídas', value: fileRowCount.toLocaleString('es-CL') },
              { label: 'columnas', value: columns.length },
              { label: 'columna de texto', value: (isThreadMode ? threadContentColumn : textColumn) || '— sin elegir —' },
              {
                label: 'llamadas al modelo',
                value: `≈ ${estimarLlamadas(fileRowCount, isThreadMode ? THREAD_BATCH_SIZE : BATCH_SIZE).toLocaleString('es-CL')}`,
              },
            ]}
            note={
              `Se procesan ${fileRowCount.toLocaleString('es-CL')} `
              + `${isThreadMode ? 'mensajes agrupados por conversación' : 'mensajes'} en lotes de `
              + `${isThreadMode ? THREAD_BATCH_SIZE : BATCH_SIZE}. El texto se envía a un proveedor de LLM externo `
              + 'para clasificarlo.'
              + (wmbEnabled ? ' Con la asistencia para «Otros» activada, los no clasificados se reprocesan en una segunda pasada.' : '')
            }
            warning={
              isThreadMode && !threadColumn
                ? 'Falta mapear el ID de conversación: sin él no se pueden agrupar los hilos.'
                : ''
            }
          />
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3 pt-1 border-t border-line">
          <button
            onClick={run}
            disabled={isRunning || !canRun}
            className={`px-5 py-2 rounded-xl text-sm font-semibold shadow-sm transition-all
              ${isRunning || !canRun
                ? 'bg-line text-ink-soft cursor-not-allowed'
                : 'bg-accent text-navy hover:brightness-95 active:scale-[0.98]'}`}>
            {isRunning ? PHASE_LABELS[phase] + '…' : 'Ejecutar análisis'}
          </button>
          {isRunning && (
            <button onClick={cancel}
              className="px-4 py-2 rounded-xl border border-rose-300 bg-white text-rose-600 hover:bg-rose-50 text-sm font-medium transition-colors">
              Cancelar
            </button>
          )}
        </div>

        {/* Phase indicator */}
        {isRunning && (
          <div className="pt-2">
            <PhaseIndicator phase={phase} progress={progress} wmbEnabled={wmbEnabled} />
          </div>
        )}

        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
      </div>

      {masterJson && phase === 5 && !isThreadMode && dashMode === 'usuario' && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => downloadOtbbDatasetExcel(filteredMaster || masterJson, metaMap, distribution || [], taggedRows || [], `maestro_${sourceBaseName}.xlsx`, {
              threadMode: false,
              threadDetailRows,
            })}
            className="px-3.5 py-1.5 rounded-xl bg-accent text-navy hover:brightness-95 text-xs font-semibold transition-colors"
          >
            Exportar maestro
          </button>
        </div>
      )}

      {/* Results */}
      {phase === 5 && distribution && reportView !== 'config' && (
        <div className="space-y-5">
          {/* ── Barra de modo: Cliente | Usuario ─────────────────────────────── */}
          {isThreadMode && (taggedRows || []).length > 0 && (
            <div className="flex items-center justify-between gap-3 px-1">
              <div className="flex rounded-xl border border-line bg-canvas overflow-hidden text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setDashMode('cliente')}
                  className={`px-4 py-1.5 transition-colors ${dashMode === 'cliente' ? 'bg-navy text-white' : 'text-ink-muted hover:text-ink'}`}
                >
                  Cliente
                </button>
                <button
                  type="button"
                  onClick={() => setDashMode('usuario')}
                  className={`px-4 py-1.5 transition-colors ${dashMode === 'usuario' ? 'bg-navy text-white' : 'text-ink-muted hover:text-ink'}`}
                >
                  Usuario
                </button>
              </div>
              {dashMode === 'usuario' && (
                <div className="flex items-center gap-2">
                  {reportJob.status === 'ready' ? (
                    <a
                      href={reportJob.pdfUrl}
                      download={`reporte_otbb_${sourceBaseName}.pdf`}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-accent bg-accent/10 text-navy hover:bg-accent/20 text-xs font-semibold transition-colors"
                    >
                      Descargar reporte PDF
                    </a>
                  ) : reportJob.status === 'creating' || reportJob.status === 'polling' ? (
                    <span className="px-3 py-1.5 rounded-xl border border-line bg-canvas text-ink-muted text-xs font-semibold">
                      Generando reporte PDF…
                      {reportJob.elapsedS ? ` ${Math.floor(reportJob.elapsedS / 60)}:${String(reportJob.elapsedS % 60).padStart(2, '0')}` : ''}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setReportView('config')}
                      title={reportJob.status === 'error' ? reportJob.error : undefined}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors
                        ${reportJob.status === 'error' ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100' : 'border-line bg-white text-ink hover:bg-canvas'}`}
                    >
                      {reportJob.status === 'error' ? 'Reintentar reporte PDF' : 'Generar reporte PDF'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => downloadOtbbDatasetExcel(
                      filteredMaster || masterJson,
                      metaMap,
                      multiCoverageDistribution,
                      taggedRows || [],
                      `maestro_${sourceBaseName}.xlsx`,
                      { threadMode: true, threadDetailRows }
                    )}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-line bg-white text-ink hover:bg-canvas text-xs font-semibold transition-colors"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Exportar maestro
                  </button>
                </div>
              )}
            </div>
          )}

          {/* El error del reporte va visible, no escondido en un title: si el job
              falla, lo único que se veía era el botón en rojo sin explicación. */}
          {isThreadMode && dashMode === 'usuario' && reportJob.status === 'error' && reportJob.error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <span className="font-semibold">El reporte PDF no se generó.</span> {reportJob.error}
            </div>
          )}

          {/* Mismo criterio que el error del reporte: un sub-flujo opcional puede
              fallar sin voltear la corrida, pero no puede fallar sin avisar. */}
          {sentimentWarning && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span className="font-semibold">Sentimiento no disponible.</span> {sentimentWarning}
            </div>
          )}

          {/* ── Conversation intelligence (Cliente + Usuario) ─────────────────── */}
          {isThreadMode && (taggedRows || []).length > 0 && (
            <OtbbThreadDashboard
              rows={flowRowsForUi.length ? flowRowsForUi : taggedRows}
              onExportMaestro={undefined}
              onReset={reset}
            />
          )}

          {/* ── KPI sumario rápido (modo mensaje, no hilo) ────────────────────── */}
          {!isThreadMode && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Mensajes procesados', value: taggedRows?.length ?? 0 },
                { label: 'Tipificaciones usadas', value: distribution.length },
                {
                  label: 'Categoría más frecuente',
                  value: distribution[0] ? codeCategoryLabel(distribution[0]) : '—',
                },
                {
                  label: 'Categoría top %',
                  value: `${distribution[0]?.pct ?? 0}%`,
                },
              ].map(s => (
                <div key={s.label} className="bg-surface border border-line rounded-panel p-4 shadow-sm">
                  <p className="text-[10px] uppercase tracking-wide font-semibold text-ink-muted mb-1">{s.label}</p>
                  <p className="text-2xl font-bold text-ink">{s.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Lectura contra el catálogo: solo modo Usuario (o modo mensaje) */}
          {(dashMode === 'usuario' || !isThreadMode) && (
          <section className="rounded-panel border border-line bg-canvas/60 p-4 sm:p-5 space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                  Análisis de catálogo
                </p>
                <h3 className="text-lg font-bold text-ink mt-0.5">
                  {isThreadMode ? 'Categorías y estructura de negocio' : 'Tipificaciones y estructura de negocio'}
                </h3>
              </div>
              <p className="text-xs text-ink-muted">
                {isThreadMode
                  ? 'De qué habla la muestra y cómo cae sobre el catálogo'
                  : 'De qué hablan los mensajes y cómo caen sobre el catálogo'}
              </p>
            </div>

            {/* Tabla de tipificaciones */}
            <div className="bg-surface border border-line rounded-panel shadow-panel overflow-hidden">
              <div className="px-5 py-3.5 border-b border-line">
                <h3 className="font-semibold text-ink text-sm">
                  {isThreadMode ? 'Categorías detectadas' : 'Tipificaciones detectadas'}
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  {isThreadMode
                    ? 'Principal = 1 por conversación. Multi = cobertura sobre los hilos que la componen.'
                    : 'Volumen y % sobre total por tipificación'}
                </p>
              </div>
              <div className="p-5 space-y-4">
                {isThreadMode ? (
                  <>
                    <CategoryDistributionBlock
                      title="Categoría principal"
                      description="Una categoría principal por conversación (thread_id)."
                      distribution={principalDistribution}
                      onEditMeta={handleEditMeta}
                      nLabel="N conversaciones"
                      pctLabel="% sobre conversaciones"
                    />
                    <CategoryDistributionBlock
                      title="Cobertura multi-categoría"
                      description="Tipificaciones de la conversación proyectadas sobre cada hilo. Puede sumar más de 100%."
                      distribution={multiCoverageDistribution}
                      onEditMeta={handleEditMeta}
                      nLabel="N hilos"
                      pctLabel="% cobertura hilos"
                    />
                  </>
                ) : (
                  <DistributionTable distribution={distribution} onEditMeta={handleEditMeta} threadMode={isThreadMode} />
                )}
              </div>
            </div>

            {isThreadMode && exclusionDistribution.length > 0 && (
              <ExclusionCoveragePanel distribution={exclusionDistribution} />
            )}

            <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
              <h3 className="font-semibold text-ink text-sm mb-1">Distribución por producto</h3>
              <p className="text-xs text-ink-muted mb-4">
                {isThreadMode
                  ? 'Categoría principal por conversación. Incluye “fuera de negocio” si aplica.'
                  : 'Peso relativo de cada tipificación dentro de su producto'}
              </p>
              <Treemap distribution={businessDistribution} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
                <h3 className="font-semibold text-ink text-sm mb-1">Etapa Comercial</h3>
                <p className="text-xs text-ink-muted mb-4">
                  {isThreadMode
                    ? 'Partición excluyente sobre el total de conversaciones'
                    : 'Venta vs Post Venta según la mezcla de la muestra'}
                </p>
                <EtapaComercialSplit distribution={businessDistribution} />
              </div>
              <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
                <h3 className="font-semibold text-ink text-sm mb-1">Capacidad Wird (principal)</h3>
                <p className="text-xs text-ink-muted mb-4">
                  {isThreadMode
                    ? 'Una capacidad principal por conversación (primera del catálogo).'
                    : 'Capacidad principal declarada en el catálogo (primera si hay varias)'}
                </p>
                <CapacidadWirdBreakdown distribution={businessDistribution} />
              </div>
            </div>

            <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
              <h3 className="font-semibold text-ink text-sm mb-1">Macro Producto › Producto › Caso de Uso</h3>
              <p className="text-xs text-ink-muted mb-4">
                {isThreadMode ? 'Dónde aparece cobertura dentro de la estructura del negocio' : 'Dónde se concentra el volumen dentro de la estructura del negocio'}
              </p>
              <HierarchyBreakdown distribution={businessDistribution} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
                <h3 className="font-semibold text-ink text-sm mb-1">Módulo del Journey</h3>
                <p className="text-xs text-ink-muted mb-4">
                  {isThreadMode ? 'Cobertura global por módulo del catálogo' : 'Distribución global por módulo del catálogo'}
                </p>
                <JourneyGlobalBreakdown distribution={businessDistribution} />
              </div>
              <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
                <h3 className="font-semibold text-ink text-sm mb-1">Producto × Módulo del Journey</h3>
                <p className="text-xs text-ink-muted mb-4">Detalle del módulo dentro de cada producto</p>
                <JourneyBreakdown distribution={businessDistribution} />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
                <h3 className="font-semibold text-ink text-sm mb-1">Por Segmento</h3>
                <p className="text-xs text-ink-muted mb-4">
                  {isThreadMode ? 'Cobertura por segmento de cliente' : 'Volumen por segmento de cliente'}
                </p>
                <SegmentoBreakdown distribution={businessDistribution} />
              </div>
              <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
                <h3 className="font-semibold text-ink text-sm mb-1">{isThreadMode ? 'Conversaciones con Adjuntos' : 'Mensajes con Adjuntos'}</h3>
                <p className="text-xs text-ink-muted mb-4">Categorías que típicamente incluyen archivos</p>
                <AdjuntosBreakdown distribution={businessDistribution} />
              </div>
            </div>
          </section>
          )}
        </div>
      )}

      {phase === 5 && isThreadMode && reportView === 'config' && (
        <OtbbReportConfig
          getWorkbookBuffer={async () => {
            const wb = buildOtbbDatasetWorkbook(
              filteredMaster || masterJson, metaMap, multiCoverageDistribution, taggedRows || [],
              { threadMode: true, threadDetailRows },
            );
            return wb.xlsx.writeBuffer();
          }}
          sourceBaseName={sourceBaseName}
          onBack={() => setReportView('results')}
          onNext={handleCreateReportJob}
        />
      )}
    </div>
  );
}

// ─── Journey Breakdown ─────────────────────────────────────────────────────────
function JourneyBreakdown({ distribution }) {
  const grouped = {};
  distribution.forEach(d => {
    const key = d.producto || 'Sin producto';
    if (!grouped[key]) grouped[key] = { items: [], journeys: {} };
    grouped[key].items.push(d);
    const j = d.journey || SIN_JOURNEY;
    if (!grouped[key].journeys[j]) grouped[key].journeys[j] = { items: [] };
    grouped[key].journeys[j].items.push(d);
  });

  const totalAll = distribution[0]?.totalBase || distribution.reduce((s, d) => s + d.n, 0);
  const countLabel = distribution[0]?.countLabel || 'msgs';
  const products = Object.entries(grouped).sort((a, b) =>
    coverageCountForItems(b[1].items) -
    coverageCountForItems(a[1].items)
  );

  return (
    <div className="space-y-5">
      {products.map(([prod, dataByProduct], pi) => {
        const prodTotal = coverageCountForItems(dataByProduct.items);
        const color = COLORS[pi % COLORS.length];
        return (
          <div key={prod}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 rounded-sm" style={{ background: color }} />
              <span className="text-sm font-semibold text-gray-800">{prod}</span>
              <span className="text-xs text-gray-400">({pct(prodTotal, totalAll)}% · {prodTotal} {countLabel})</span>
            </div>
            <div className="pl-5 space-y-1.5">
              {Object.entries(dataByProduct.journeys)
                .map(([journey, data]) => ({ journey, n: coverageCountForItems(data.items), data }))
                .sort((a, b) => b.n - a.n)
                .map(({ journey, n }) => (
                  <div key={journey} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-52 truncate" title={journey}>{journey}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                           style={{ width: `${pct(n, prodTotal)}%`, background: color }} />
                    </div>
                    <span className="text-xs font-semibold text-gray-700 w-10 text-right tabular-nums">
                      {pct(n, prodTotal)}%
                    </span>
                    <span className="text-xs text-gray-400 w-14 tabular-nums">{n} {countLabel}</span>
                  </div>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Agregación genérica por campo del catálogo ─────────────────────────────────
function aggregateBy(distribution, key, fallback = 'Sin dato') {
  const acc = {};
  const threadMode = isThreadDistribution(distribution);
  distribution.forEach(d => {
    const label = String(d[key] || '').trim() || fallback;
    if (threadMode) {
      acc[label] = acc[label] || new Set();
      (d.rowKeys || []).forEach(rowKey => acc[label].add(rowKey));
    } else {
      acc[label] = (acc[label] || 0) + d.n;
    }
  });
  const total = distribution[0]?.totalBase || Object.values(acc).reduce((s, n) => s + (threadMode ? n.size : n), 0);
  const countLabel = distribution[0]?.countLabel || 'msgs';
  return Object.entries(acc)
    .map(([label, value]) => {
      const n = threadMode ? value.size : value;
      return { label, n, pct: pct(n, total), countLabel };
    })
    .sort((a, b) => b.n - a.n);
}

// ─── Lista de barras reutilizable ───────────────────────────────────────────────
function BarBreakdown({ items, colorFor }) {
  const countLabel = items[0]?.countLabel || 'msgs';
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const color = colorFor ? colorFor(item, i) : COLORS[i % COLORS.length];
        return (
          <div key={item.label} className="flex items-center gap-3">
            <span className="text-xs text-gray-600 w-48 truncate" title={item.label}>{item.label}</span>
            <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
              <div className="h-full rounded-full transition-all"
                   style={{ width: `${Math.min(item.pct, 100)}%`, background: color }} />
            </div>
            <span className="text-xs font-semibold text-gray-700 w-12 text-right tabular-nums">{item.pct}%</span>
            <span className="text-xs text-gray-400 w-16 text-right tabular-nums">{item.n} {countLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Split Etapa Comercial (Venta vs Post Venta) ────────────────────────────────
function EtapaComercialSplit({ distribution }) {
  const items = aggregateBy(distribution, 'etapaComercial', 'Sin etapa');
  const countLabel = distribution[0]?.countLabel || 'msgs';
  const colorFor = (item) => {
    if (/post/i.test(item.label)) return '#f59e0b';
    if (/venta/i.test(item.label)) return '#6366f1';
    if (/sin/i.test(item.label)) return '#94a3b8';
    return '#94a3b8';
  };
  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        {items.map(item => (
          <div key={item.label} className="flex-1 min-w-[140px] rounded-xl border border-gray-100 p-4"
               style={{ background: /post/i.test(item.label) ? '#fffbeb' : /venta/i.test(item.label) ? '#eef2ff' : '#f8fafc' }}>
            <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 mb-1">{item.label}</p>
            <p className="text-2xl font-bold text-gray-800">{item.pct}%</p>
            <p className="text-xs text-gray-400 mt-0.5">{item.n} {countLabel}</p>
          </div>
        ))}
      </div>
      <BarBreakdown items={items} colorFor={colorFor} />
    </div>
  );
}

// ─── Jerarquía Macro Producto › Producto › Caso de Uso ──────────────────────────
function HierarchyBreakdown({ distribution }) {
  const tree = {};
  distribution.forEach(d => {
    const macro = d.macroProducto || 'Sin macro producto';
    const prod  = d.producto || 'Sin producto';
    const caso  = d.casoUso || 'Sin caso de uso';
    tree[macro] = tree[macro] || { items: [], productos: {} };
    tree[macro].items.push(d);
    tree[macro].productos[prod] = tree[macro].productos[prod] || { items: [], casos: {} };
    tree[macro].productos[prod].items.push(d);
    tree[macro].productos[prod].casos[caso] = tree[macro].productos[prod].casos[caso] || [];
    tree[macro].productos[prod].casos[caso].push(d);
  });

  const totalAll = distribution[0]?.totalBase || distribution.reduce((s, d) => s + d.n, 0);
  const countLabel = distribution[0]?.countLabel || 'msgs';
  const macros = Object.entries(tree).sort((a, b) => coverageCountForItems(b[1].items) - coverageCountForItems(a[1].items));

  return (
    <div className="space-y-4">
      {macros.map(([macro, mData], mi) => {
        const macroN = coverageCountForItems(mData.items);
        const color = COLORS[mi % COLORS.length];
        return (
          <div key={macro} className="rounded-xl border border-gray-100 p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />
              <span className="text-sm font-bold text-gray-800">{macro}</span>
              <span className="text-xs text-gray-400 ml-auto">{pct(macroN, totalAll)}% · {macroN} {countLabel}</span>
            </div>
            <div className="pl-5 space-y-3">
              {Object.entries(mData.productos)
                .map(([prod, pData]) => ({ prod, pData, n: coverageCountForItems(pData.items) }))
                .sort((a, b) => b.n - a.n)
                .map(({ prod, pData, n: prodN }) => (
                  <div key={prod}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-gray-700">{prod}</span>
                      <span className="text-[11px] text-gray-400 ml-auto">{pct(prodN, macroN)}% · {prodN}</span>
                    </div>
                    <div className="pl-3 space-y-1">
                      {Object.entries(pData.casos)
                        .map(([caso, items]) => ({ caso, n: coverageCountForItems(items) }))
                        .sort((a, b) => b.n - a.n)
                        .map(({ caso, n }) => (
                          <div key={caso} className="flex items-center gap-2">
                            <span className="text-[11px] text-gray-500 w-56 truncate" title={caso}>{caso}</span>
                            <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${pct(n, prodN)}%`, background: color }} />
                            </div>
                            <span className="text-[11px] text-gray-400 w-10 text-right tabular-nums">{n}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Capacidad Wird (primera capacidad = partición excluyente) ──────────────────
function CapacidadWirdBreakdown({ distribution }) {
  const normalized = (distribution || []).map(item => {
    const primary = String(item.capacidadWird || '')
      .split(/\/\/\/|;|,|\|/g)
      .map(v => v.trim())
      .filter(Boolean)[0] || '';
    return { ...item, capacidadWird: primary };
  });
  const items = aggregateBy(normalized, 'capacidadWird', 'Sin capacidad definida');
  return <BarBreakdown items={items} colorFor={(item) => /no|sin/i.test(item.label) ? '#94a3b8' : '#10b981'} />;
}

// ─── Distribución por Segmento ──────────────────────────────────────────────────
function SegmentoBreakdown({ distribution }) {
  const items = aggregateBy(distribution, 'segmento', 'Sin segmento');
  return <BarBreakdown items={items} />;
}

// ─── Mensajes con Adjuntos ──────────────────────────────────────────────────────
function AdjuntosBreakdown({ distribution }) {
  const items = aggregateBy(distribution, 'adjuntos', 'Sin dato');
  return <BarBreakdown items={items} colorFor={(item) => /sí|si|s[ií]\b|aplica|true/i.test(item.label) ? '#06b6d4' : '#94a3b8'} />;
}

// ─── Journey transversal (global) ───────────────────────────────────────────────
function JourneyGlobalBreakdown({ distribution }) {
  const items = aggregateBy(distribution, 'journey', SIN_JOURNEY);
  return <BarBreakdown items={items} />;
}
