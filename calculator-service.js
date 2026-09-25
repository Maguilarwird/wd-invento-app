/**
 * Estimación de costes (tokens y USD) alineada con multitag-api/estimate_use_case_cost.py
 * y con los prompts de invento-app (etiquetado.js, invento.js + prompts.json).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getBancaMaster, getFlowDefinitions, getFrictionCatalog } from './catalog-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _promptsJson = null;
function getPromptsJson() {
  if (!_promptsJson) {
    _promptsJson = JSON.parse(readFileSync(join(__dirname, 'src', 'prompts.json'), 'utf8'));
  }
  return _promptsJson;
}

/** Aproximación tipo tiktoken fallback: ~4 caracteres por token */
export function countTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Presets en caracteres (texto gris UX): correo ~600, RRSS ~250, encuestas ~350 */
export const CHAR_PRESETS = {
  correo: 600,
  rrss: 250,
  encuesta: 350,
};

export function resolveAvgChars({ preset, customValue, unit, totalTokens, numMessages }) {
  // Modo "total de tokens del dataset": reparte el total entre los mensajes y
  // convierte a caracteres promedio (~4 chars por token).
  if (unit === 'total_tokens' && totalTokens != null && totalTokens > 0) {
    const n = Math.max(1, Math.floor(Number(numMessages)) || 1);
    return (Number(totalTokens) * 4) / n;
  }
  if (preset === 'custom' && customValue != null && customValue > 0) {
    if (unit === 'tokens') return customValue * 4;
    return customValue;
  }
  return CHAR_PRESETS[preset] ?? CHAR_PRESETS.correo;
}

function sampleBodyForTargetChars(targetChars, channelStyle) {
  if (targetChars <= 0) return 'x';
  const pad =
    channelStyle === 'rrss'
      ? ' Hola @banco necesito ayuda con mi cuenta. '
      : channelStyle === 'encuesta'
        ? ' Respuesta a encuesta: calificación y comentario breve. '
        : ' Estimado equipo, les escribo respecto a mi caso. Adjunto antecedentes. ';
  let s =
    channelStyle === 'rrss'
      ? 'Hola @banco '
      : channelStyle === 'encuesta'
        ? 'Encuesta: '
        : 'Asunto: Consulta\n\nEstimado equipo,\n\n';
  while (s.length < targetChars) s += pad;
  return s.slice(0, targetChars);
}

function buildCategoriesStr(lista) {
  return Object.entries(lista)
    .map(([code, name]) => `${code}: ${name}`)
    .join('\n');
}

function estimateJsonOutputTokens(codes) {
  const body = codes.map((c) => `"${c}":0`).join(',');
  return countTokens(`{${body}}`);
}

/** System prompts como en etiquetado.js */
function buildEtiquetadoSystemSingle(categoriesStr, ignoreStr, deriveStr) {
  return `Eres un asistente encargado de clasificar mensajes de clientes (correos, tweets o tickets de soporte al cliente) en una sola categoría. \n\n### Categorías Disponibles ###\n${categoriesStr}\n\n### Instrucciones ###\n- Analiza el correo y determina la categoría relevante.\n- Los nombres de las categorías pueden contener información entre corchetes ([]), esto es la definición de la categoría, que aporta información adicional y debes usarla para responder de forma mas precisa.\n- Responde ÚNICAMENTE con un JSON donde:\n- Las claves son los códigos de categoría (ej: WMA001).\n- El valor de la categoría que corresponde debe ser 1, todas las demás deben ser 0.\n${ignoreStr ? `- Si el mensaje presenta alguna de estas frases/palabras (sin importar mayusculas o minusculas y considerando faltas de ortografías) ${ignoreStr} debes responder automaticamente WMI000: 1 y todas las demas claves con 0` : ''}\n${deriveStr ? `- Si el mensaje presenta alguna de estas frases/palabras (sin importar mayusculas o minusculas y considerando faltas de ortografías) ${deriveStr} debes responder automaticamente WMD000: 1 y todas las demas claves con 0` : ''}\n- Incluye TODAS las categorías listadas, aunque su valor sea 0.\n- No agregues comentarios, explicaciones ni formato adicional.\n\nRecuerda que SOLAMENTE UNA CATEGORÍA PUEDE TENER VALOR 1.\n\nEjemplo de respuesta válida:\n{\n"WMA001": 0,\n"WMA002": 1,\n"WMA003": 0\n}`;
}

function buildEtiquetadoSystemMultitag(categoriesStr, ignoreStr, deriveStr) {
  return `Eres un asistente encargado de clasificar mensajes de clientes (correos, tweets o tickets de soporte al cliente) en múltiples categorías. \n\n### Categorías Disponibles ###\n${categoriesStr}\n\n### Instrucciones ###\n- Analiza el correo y determina qué categorías son relevantes.\n- Los nombres de las categorías pueden contener información entre corchetes ([]), esto es la definición de la categoría, que aporta información adicional y debes usarla para responder de forma mas precisa.\n- Responde ÚNICAMENTE con un JSON donde:\n- Las claves son los códigos de categoría (ej: WMA001).\n- Los valores son 1 si la categoría aplica, 0 si no.\n${ignoreStr ? `- Si el mensaje presenta alguna de estas frases/palabras (sin importar mayusculas o minusculas y considerando faltas de ortografías) ${ignoreStr} debes responder automaticamente WMI000: 1 y todas las demas claves con 0` : ''}\n${deriveStr ? `- Si el mensaje presenta alguna de estas frases/palabras (sin importar mayusculas o minusculas y considerando faltas de ortografías) ${deriveStr} debes responder automaticamente WMD000: 1 y todas las demas claves con 0` : ''}\n- Incluye TODAS las categorías listadas, aunque su valor sea 0.\n- No agregues comentarios, explicaciones ni formato adicional.\n\nEjemplo de respuesta válida:\n{\n"WMA001": 0,\n"WMA002": 1,\n"WMA003": 0\n}`;
}

/** Segunda llamada (referencia multitag-api / prompts.py) */
function buildMergePromptSample(cliente, lista, avgTemplateChars, numAplicables, responsesText = '') {
  const codes = Object.keys(lista).slice(0, Math.max(2, numAplicables));
  const aplicables = [];
  const templatesChunks = [];
  for (const code of codes) {
    aplicables.push(`${code} - ${lista[code]}`);
    const filler = 'x'.repeat(Math.max(0, avgTemplateChars - 20));
    templatesChunks.push(`${code}: Respuesta plantilla. ${filler}`);
  }
  let templatesStr = templatesChunks.join('\n\n');
  if (responsesText && String(responsesText).trim()) {
    templatesStr += `\n\n### Respuestas / plantillas cargadas ###\n${String(responsesText).trim()}`;
  }
  const aplicablesBlock = aplicables.join('\n');
  const system = `Eres un asistente encargado de responder mensajes de clientes de la empresa ${cliente}. 

            ### Instrucciones ###
            - Analiza el correo y la lista de categorías en las que se clasificó. Para cada categoría de la lista se propone un template de respuesta.
            - Debes crear un único template en base a los que se te presentan, una especie de combinacion entre ambos, siempre tratando de responder de forma correcta a lo que menciona el tweet.
            - Lo mas importante es la coherencia de la respuesta, los templates son simples y genericos y asi debe ser la respuesta. si los template NO responden de forma correcta/coherente a la problematica del cliente debes responder UNICAMENTE "Sin respuesta"
            - Prioriza la categoría que mas relación tenga con el caso, agregando elementos de los otros templates.
            - Usa máximo 2 oraciones concisas
            
            ### Lista de Categorías ###
            ${aplicablesBlock}
            
            ### Templates ###
            ${templatesStr}
            
            `;
  return { system, templatesStr };
}

export function estimateEtiquetado(body) {
  const {
    categoriasJson,
    preset = 'correo',
    customValue,
    unit = 'chars',
    totalTokens,
    numMessages,
    taggingMode = 'single',
    ignorePhrases = [],
    derivePhrases = [],
    knowledgeBaseText = '',
    responsesText = '',
    clientName = 'Cliente',
    multitagSecondCallRate = 0.2,
    mergeNumAplicables = 2,
    avgTemplateChars = 200,
    includeMergeSecondCall = true,
    inputPricePer1mUsd = 2.0,
    outputPricePer1mUsd = 8.0,
  } = body;

  let lista;
  try {
    lista = typeof categoriasJson === 'string' ? JSON.parse(categoriasJson) : categoriasJson;
  } catch {
    throw new Error('JSON de categorías inválido.');
  }
  if (!lista || typeof lista !== 'object' || Array.isArray(lista)) {
    throw new Error('El JSON de categorías debe ser un objeto { codigo: descripción }.');
  }

  const codes = Object.keys(lista);
  const categoriesStr = buildCategoriesStr(lista);
  const categoriesStrWithKb =
    knowledgeBaseText && String(knowledgeBaseText).trim()
      ? `${categoriesStr}\n\n### Base de conocimiento adicional ###\n${String(knowledgeBaseText).trim()}`
      : categoriesStr;

  const ignoreStr = ignorePhrases.length ? ignorePhrases.join(', ') : null;
  const deriveStr = derivePhrases.length ? derivePhrases.join(', ') : null;

  const avgChars = resolveAvgChars({ preset, customValue, unit, totalTokens, numMessages });
  const channelStyle = preset === 'rrss' ? 'rrss' : preset === 'encuesta' ? 'encuesta' : 'correo';
  const sampleText = sampleBodyForTargetChars(avgChars, channelStyle);
  const userClassify = `### Texto ###\n${sampleText}\n\n### JSON categorias: `;

  let systemClassify;
  if (taggingMode === 'single') {
    systemClassify = buildEtiquetadoSystemSingle(categoriesStrWithKb, ignoreStr, deriveStr);
  } else {
    systemClassify = buildEtiquetadoSystemMultitag(categoriesStrWithKb, ignoreStr, deriveStr);
  }

  const tokensInClassify = countTokens(systemClassify) + countTokens(userClassify);
  const tokensOutClassify = estimateJsonOutputTokens(codes);

  let tokensInMerge = 0;
  let tokensOutMerge = 0;
  let effectiveSecondRate = 0;

  if (taggingMode === 'multitag' && includeMergeSecondCall) {
    effectiveSecondRate = Math.max(0, Math.min(1, Number(multitagSecondCallRate) || 0));
    const { system: sysM } = buildMergePromptSample(
      clientName,
      lista,
      avgTemplateChars,
      mergeNumAplicables,
      responsesText
    );
    tokensInMerge = countTokens(sysM) + countTokens(`### Tweet ###\n${sampleText}\n\n### Respuesta Template: `);
    tokensOutMerge = countTokens('Gracias por escribirnos. Le ayudamos con su caso.');
  }

  const totalIn = tokensInClassify + effectiveSecondRate * tokensInMerge;
  const totalOut = tokensOutClassify + effectiveSecondRate * tokensOutMerge;

  const usdPerMessage =
    (totalIn / 1e6) * inputPricePer1mUsd + (totalOut / 1e6) * outputPricePer1mUsd;

  const nMsg = Math.max(1, Math.floor(Number(numMessages)) || 1);
  const usdTotalRun = usdPerMessage * nMsg;
  const totalTokensIn = totalIn * nMsg;
  const totalTokensOut = totalOut * nMsg;

  return {
    preset,
    avgCharsResolved: avgChars,
    avgTokensApprox: countTokens(sampleText),
    taggingMode,
    numCategorias: codes.length,
    numMessages: nMsg,
    tokensInClassify,
    tokensOutClassify,
    multitagMerge: taggingMode === 'multitag' && includeMergeSecondCall
      ? {
          tokensInMerge,
          tokensOutMerge,
          secondCallRate: effectiveSecondRate,
          note:
            'Segunda llamada ponderada según multitag-api (merge de plantillas). La app invento etiquetado actual solo ejecuta la 1ª llamada; activa esto para comparar con el estimador Python.',
        }
      : null,
    totalTokensInEffective: totalIn,
    totalTokensOutEffective: totalOut,
    usdPerMessage,
    usdTotalRun,
    totalTokensIn,
    totalTokensOut,
    totalTokens: totalTokensIn + totalTokensOut,
    inputPricePer1mUsd,
    outputPricePer1mUsd,
  };
}

function countClusteringBatches(numRows, avgRowLen, promptInstruction, contextSize = 30000) {
  const separator = '\n';
  const baseTokens = promptInstruction.length + separator.length;
  let batches = 0;
  let currentBatchTokens = baseTokens;

  for (let i = 0; i < numRows; i++) {
    const datumTokens = avgRowLen + separator.length;
    if (currentBatchTokens + datumTokens <= contextSize) {
      currentBatchTokens += datumTokens;
    } else {
      batches += 1;
      currentBatchTokens = baseTokens + datumTokens;
    }
  }
  if (currentBatchTokens > baseTokens) batches += 1;
  return Math.max(1, batches);
}

export function estimateLevantamiento(body) {
  const {
    medium = 'CORREO',
    companyType = 'banca',
    numMensajes = 1000,
    preset = 'correo',
    customValue,
    unit = 'chars',
    totalTokens,
    nCategories = '0',
    estimatedTopics = null,
    inputPriceGptPer1m = 2.0,
    outputPriceGptPer1m = 8.0,
    inputPriceClaudePer1m = 3.0,
    outputPriceClaudePer1m = 15.0,
  } = body;

  const nMsg = Math.max(1, Math.floor(Number(numMensajes)) || 1);

  const prompts = getPromptsJson();
  const key = medium.toUpperCase();
  const block = prompts.CLUSTERING_1[key];
  if (!block) {
    throw new Error(`Medio no soportado: ${medium}. Use CORREO, RRSS o ENCUESTA.`);
  }

  const promptInstruction = block.PROMPT;
  const avgChars = resolveAvgChars({ preset, customValue, unit, totalTokens, numMessages: nMsg });
  const rowLen = Math.max(20, avgChars);
  const numBatches = countClusteringBatches(nMsg, rowLen, promptInstruction, 30000);
  const FUNC_OVERHEAD = 550;

  const baseRows = Math.floor(nMsg / numBatches);
  const rem = nMsg % numBatches;
  let tokensClusteringIn = 0;
  let tokensClusteringOut = 0;

  for (let b = 0; b < numBatches; b++) {
    const rowsThisBatch = baseRows + (b < rem ? 1 : 0);
    const chunkJoinLen = Math.max(1, rowsThisBatch * (rowLen + 1) - 1);
    const chunkText = 'x'.repeat(chunkJoinLen);
    const userInput = promptInstruction.replace('{0}', companyType).replace('{1}', chunkText);
    tokensClusteringIn += countTokens(userInput) + FUNC_OVERHEAD;
    tokensClusteringOut += Math.min(4000, 80 * Math.max(1, rowsThisBatch) + 200);
  }

  const nCat = parseInt(String(nCategories), 10) || 0;
  const topics =
    estimatedTopics != null && estimatedTopics > 0
      ? estimatedTopics
      : Math.min(150, Math.max(15, Math.ceil(nMsg / 4)));

  const fakeClusterList = Array.from({ length: topics }, (_, i) => `Temática simulada ${i + 1} breve`);
  const claudePrompt =
    nCat === 0
      ? `A continuación te mostraré una lista de temáticas... (modo libre, mín. 10). Temáticas: ${fakeClusterList.join(', ')}`
      : `Reducir a exactamente ${nCat} temáticas. Temáticas: ${fakeClusterList.join(', ')}`;

  const tokensClaudeIn = countTokens(claudePrompt) + 200;
  const tokensClaudeOut = 6000;

  const formatterSystem = `Eres un sistema que formatea textos en formato JSON. Debes formatear el texto de categorías y subcategorías en el siguiente formato:
{
  "Categoría 1": ["Subcategoría 1", "Subcategoría 2"],
  "Categoría 2": ["Subcategoría 3"],
  "Otros": ["Sin clasificar"]
}`;
  const tokensGptFormatIn = countTokens(formatterSystem) + tokensClaudeOut;
  const tokensGptFormatOut = 2500;

  const usdClustering =
    (tokensClusteringIn / 1e6) * inputPriceGptPer1m + (tokensClusteringOut / 1e6) * outputPriceGptPer1m;
  const usdClaude =
    (tokensClaudeIn / 1e6) * inputPriceClaudePer1m + (tokensClaudeOut / 1e6) * outputPriceClaudePer1m;
  const usdFormat =
    (tokensGptFormatIn / 1e6) * inputPriceGptPer1m + (tokensGptFormatOut / 1e6) * outputPriceGptPer1m;

  return {
    medium: key,
    numMensajes: nMsg,
    avgCharsPerMessage: avgChars,
    numBatchesClustering: numBatches,
    tokensClusteringIn,
    tokensClusteringOut,
    tokensClaudeIn,
    tokensClaudeOut,
    tokensGptFormatIn,
    tokensGptFormatOut,
    totalTokens:
      tokensClusteringIn + tokensClusteringOut +
      tokensClaudeIn + tokensClaudeOut +
      tokensGptFormatIn + tokensGptFormatOut,
    estimatedTopicsUsed: topics,
    note:
      'Aproximación: batches como invento.js (30k chars), luego 1× Claude para categorías y 1× GPT para JSON. Las temáticas intermedias se estiman; ajusta "temáticas estimadas" si lo conoces.',
    usdClustering,
    usdClaude,
    usdFormat,
    usdTotalRun: usdClustering + usdClaude + usdFormat,
    prices: { inputPriceGptPer1m, outputPriceGptPer1m, inputPriceClaudePer1m, outputPriceClaudePer1m },
  };
}

/**
 * Largo promedio (en caracteres) de las definiciones de un catálogo.
 * Toma el contenido entre corchetes "Nombre [definición]" si existe; si no,
 * usa el valor completo. Devuelve null si el catálogo no es válido o está vacío.
 */
function avgDefinitionChars(categoriasJson) {
  let lista;
  try {
    lista = typeof categoriasJson === 'string' ? JSON.parse(categoriasJson) : categoriasJson;
  } catch {
    return null;
  }
  if (!lista || typeof lista !== 'object' || Array.isArray(lista)) return null;
  const values = Object.values(lista);
  if (!values.length) return null;

  let sum = 0;
  for (const v of values) {
    const str = String(v ?? '');
    const open = str.indexOf('[');
    const close = str.lastIndexOf(']');
    const def = open !== -1 && close > open ? str.slice(open + 1, close) : str;
    sum += def.trim().length;
  }
  return sum / values.length;
}

/**
 * Estima el coste del LLM-as-a-Judge (AutoQA) tal como lo implementa
 * /proxy/judge: Claude juzga TODOS los mensajes y Gemini 3.5 Flash solo se
 * invoca en la fracción de desacuerdo (disagreementRate).
 */
export function estimateAutoqaJudge(body) {
  const {
    numMessages = 1000,
    preset = 'correo',
    customValue,
    unit = 'chars',
    totalTokens,
    categoriasJson = null,
    defChars = 300,
    justifChars = 200,
    disagreementRate = 0.2,
    inputPriceClaudePer1m = 3.0,
    outputPriceClaudePer1m = 15.0,
    inputPriceGeminiPer1m = 0.3,
    outputPriceGeminiPer1m = 2.5,
  } = body;

  const nMsg = Math.max(1, Math.floor(Number(numMessages)) || 1);
  const rate = Math.max(0, Math.min(1, Number(disagreementRate) || 0));

  // El largo de la definición se deriva del maestro de categorías (igual que
  // el etiquetado); si no se entrega un catálogo válido, se usa defChars.
  const derivedDefChars = avgDefinitionChars(categoriasJson);
  const effDefChars = derivedDefChars != null ? derivedDefChars : defChars;

  const avgChars = resolveAvgChars({ preset, customValue, unit, totalTokens, numMessages: nMsg });
  const channelStyle = preset === 'rrss' ? 'rrss' : preset === 'encuesta' ? 'encuesta' : 'correo';
  const sampleText = sampleBodyForTargetChars(avgChars, channelStyle);
  const sampleDef = 'x'.repeat(Math.max(0, Math.floor(effDefChars)));
  const sampleJustif = 'x'.repeat(Math.max(0, Math.floor(justifChars)));

  // Reconstrucción del judgePrompt de server.js (mismo prompt para ambos jueces).
  const judgePrompt = `Eres un juez experto en clasificación de mensajes de clientes. Debes evaluar si la categoría asignada a un mensaje es correcta.

MENSAJE DEL CLIENTE:
"${sampleText}"

CATEGORÍA ASIGNADA: WMA001 - Categoría de ejemplo
DEFINICIÓN DE LA CATEGORÍA: ${sampleDef}
JUSTIFICACIÓN DEL MODELO: ${sampleJustif}

TAREA: Evalúa si la categoría asignada es correcta para este mensaje.
Responde ÚNICAMENTE con JSON en este formato exacto:
{
  "acuerdo": true o false,
  "categoria_sugerida": "código y nombre de la categoría más apropiada, o null si estás de acuerdo",
  "razon": "explicación breve de tu evaluación (máx. 2 oraciones)"
}`;

  const tokensInPerCall = countTokens(judgePrompt);
  // Salida JSON corta: acuerdo + categoria_sugerida + razon (~2 oraciones).
  const tokensOutPerCall = countTokens(
    '{"acuerdo": false, "categoria_sugerida": "WMA005 - Otra categoría", "razon": "El mensaje no corresponde a la categoría asignada porque trata otro tema."}'
  );

  const claudeCalls = nMsg;
  const geminiCalls = Math.round(nMsg * rate);

  const claudeTokensIn = claudeCalls * tokensInPerCall;
  const claudeTokensOut = claudeCalls * tokensOutPerCall;
  const geminiTokensIn = geminiCalls * tokensInPerCall;
  const geminiTokensOut = geminiCalls * tokensOutPerCall;

  const usdClaude =
    (claudeTokensIn / 1e6) * inputPriceClaudePer1m + (claudeTokensOut / 1e6) * outputPriceClaudePer1m;
  const usdGemini =
    (geminiTokensIn / 1e6) * inputPriceGeminiPer1m + (geminiTokensOut / 1e6) * outputPriceGeminiPer1m;

  return {
    numMessages: nMsg,
    avgCharsPerMessage: Math.round(avgChars),
    avgDefChars: Math.round(effDefChars),
    defSource: derivedDefChars != null ? 'maestro' : 'valor por defecto',
    disagreementRate: rate,
    claudeCalls,
    geminiCalls,
    tokensInPerCall,
    tokensOutPerCall,
    claudeTokensIn,
    claudeTokensOut,
    geminiTokensIn,
    geminiTokensOut,
    totalTokens:
      claudeTokensIn + claudeTokensOut + geminiTokensIn + geminiTokensOut,
    usdClaude,
    usdGemini,
    usdTotal: usdClaude + usdGemini,
    note:
      'Claude juzga todos los mensajes; Gemini 3.5 Flash solo se invoca en la fracción de desacuerdo (Claude=false). Aproximación de tokens basada en el judgePrompt real de /proxy/judge.',
    prices: {
      inputPriceClaudePer1m,
      outputPriceClaudePer1m,
      inputPriceGeminiPer1m,
      outputPriceGeminiPer1m,
    },
  };
}

/** Compatibilidad: estimateAutoqa apunta al estimador del LLM-as-a-Judge. */
export const estimateAutoqa = estimateAutoqaJudge;

/**
 * Estima el coste del módulo de corrección de AutoQA (/proxy/correct):
 * por cada categoría a revisar se hace 1 llamada a GPT-4.1-mini que recibe la
 * definición actual + N ejemplos mal clasificados y devuelve hasta 800 tokens.
 */
export function estimateAutoqaCorreccion(body) {
  const {
    numCategories = 25,
    examplesPerCategory = 8,
    avgExampleChars = 250,
    defChars = 300,
    maxOutputTokens = 1600,
    inputPricePer1mUsd = 2.0,
    outputPricePer1mUsd = 8.0,
  } = body;

  const nCat = Math.max(1, Math.floor(Number(numCategories)) || 1);
  const nEx = Math.max(0, Math.floor(Number(examplesPerCategory)) || 0);

  const sampleDef = 'x'.repeat(Math.max(0, Math.floor(defChars)));
  const examplesStr = Array.from({ length: nEx }, (_, i) =>
    `${i + 1}. "${'x'.repeat(Math.max(0, Math.floor(avgExampleChars)))}"`
  ).join('\n');

  // Aproximación del prompt de redefinición de /proxy/correct.
  const promptSample = `Eres un experto en diseño de taxonomías de clasificación de mensajes de clientes. La categoría "WMA001 - Categoría de ejemplo" tiene mensajes que fueron clasificados incorrectamente según el juez.

CATEGORÍA: WMA001 - Categoría de ejemplo
DEFINICIÓN ACTUAL: ${sampleDef}

MENSAJES MAL CLASIFICADOS EN ESTA CATEGORÍA (${nEx}):
${examplesStr}

Tu tarea es decidir la MEJOR acción correctiva entre dos opciones: "redefine" o "new_category". Responde ÚNICAMENTE con JSON con los campos action, suggested_definition, new_category_name, new_category_definition y razon.`;

  const tokensInPerCall = countTokens(promptSample);
  const tokensOutPerCall = Math.min(Number(maxOutputTokens) || 1600, 1600);

  const tokensIn = nCat * tokensInPerCall;
  const tokensOut = nCat * tokensOutPerCall;

  const usdTotal =
    (tokensIn / 1e6) * inputPricePer1mUsd + (tokensOut / 1e6) * outputPricePer1mUsd;

  return {
    numCategories: nCat,
    examplesPerCategory: nEx,
    tokensInPerCall,
    tokensOutPerCall,
    tokensIn,
    tokensOut,
    totalTokens: tokensIn + tokensOut,
    usdTotal,
    note:
      'Una llamada a GPT-4.1 por categoría a revisar (redefinir o proponer categoría nueva), siguiendo el prompt de /proxy/correct (max_tokens 1600).',
    prices: { inputPricePer1mUsd, outputPricePer1mUsd },
  };
}

// Lo que pesa en el prompt de OTBB son los catálogos, y hardcodear su tamaño lo
// dejaba desfasado en un orden de magnitud. Se mide sobre los mismos archivos que
// carga la app; catalog-service ya cachea por mtime, así que esto sigue al dato.
let _otbbSizes = null;
function otbbCatalogSizes() {
  if (_otbbSizes) return _otbbSizes;
  const { masterJson, metaMap } = getBancaMaster();
  const codes = Object.keys(masterJson);
  // Mismo armado que buildOtbbCatalogLines en src/invento.js: el catálogo entero
  // con su ruta de negocio viaja en la única llamada a Claude.
  const catalogLines = codes.map(code => {
    const meta = metaMap[code] || {};
    const path = [meta.macroProducto, meta.producto, meta.casoUso, meta.categoria, meta.subcategoria]
      .filter(Boolean)
      .join(' > ');
    return `${code}: ${masterJson[code]}${path ? `\nRuta: ${path}` : ''}`;
  }).join('\n\n');
  const masterLines = codes.map(code => `${code}: ${masterJson[code]}`).join('\n');
  const flowPrompts = getFlowDefinitions().prompts || {};
  _otbbSizes = {
    catalogPromptTokens: countTokens(catalogLines),
    avgMasterLineTokens: codes.length ? countTokens(masterLines) / codes.length : 0,
    taxonomyPromptTokens:
      ['Apertura', 'Gestion', 'Desenlace'].reduce((sum, key) => sum + countTokens(flowPrompts[key] || ''), 0)
      + countTokens(getFrictionCatalog().prompt || ''),
  };
  return _otbbSizes;
}

/**
 * Estimación de costes para "Open The Black Box":
 *   Fase 1 — GPT-4.1 extrae temáticas de la muestra.
 *   Fase 2 — Claude Sonnet 4.6 mapea temáticas a WMAs existentes.
 *   Fase 3 — GPT etiqueta todos los mensajes en batches de 10.
 */
export function estimateOtbb({
  numMessages             = 500,
  analysisMode            = 'first_interaction',
  preset                  = 'correo',
  customValue             = null,
  unit                    = 'chars',
  totalTokens             = null,
  inputPriceClaudePer1m   = 3.0,
  outputPriceClaudePer1m  = 15.0,
  inputPriceGptPer1m      = 2.0,
  outputPriceGptPer1m     = 8.0,
  includesWmb             = false,   // Asistencia IA para "Otros"
  wmbNCategories          = 0,       // 0 = auto (~10), otro valor = exacto
  wmbOtrosRate            = 0.25,    // fracción estimada de mensajes que caen en WMA000
  avgTurnsPerThread       = 3,       // solo modo hilo: define el tamaño de la salida
} = {}) {
  const nMsg = Math.max(1, Math.floor(Number(numMessages)) || 1);
  const isThread = analysisMode === 'thread';
  let avgChars = resolveAvgChars({ preset, customValue, unit, totalTokens, numMessages: nMsg });
  if (isThread && preset === 'correo' && customValue == null && unit === 'chars') {
    avgChars = 900;
  }

  // OTBB_MAX_ACTIVE_WMAS en src/invento.js: el maestro activo se recorta a 45.
  const ACTIVE_WMAS   = 45;
  const BATCH_TAGGING = 10;
  const THREAD_BATCH_TAGGING = 5;
  // OTBB_CLUSTER_CONTEXT_SIZE en src/invento.js: OTBB usa chunks más chicos que
  // Levantamiento para no colgar el navegador.
  const CLUSTER_CTX_CHARS = 12000;
  const sizes = otbbCatalogSizes();
  // Las bases de flujo y fricciones viajan enteras en el system prompt de cada
  // batch de hilos.
  const TAXONOMY_PROMPT_TOKENS = sizes.taxonomyPromptTokens;
  const turnsPerThread = isThread ? Math.max(1, Math.floor(Number(avgTurnsPerThread)) || 3) : 1;

  // ── Fase GPT-4.1: extracción de temáticas ──────────────────────────────────
  // El prompt de clustering es el de prompts.json más el addendum de OTBB.
  const promptOverheadChars = getPromptsJson().CLUSTERING_1.CORREO.PROMPT.length + 200;
  const rowLen = Math.max(1, Math.floor(avgChars));
  const rowsPerClusterBatch = Math.max(
    1,
    Math.floor((CLUSTER_CTX_CHARS - promptOverheadChars) / (rowLen + 1))
  );
  const numBatchesClustering = Math.ceil(nMsg / rowsPerClusterBatch);
  const baseRows = Math.floor(nMsg / numBatchesClustering);
  const rem = nMsg % numBatchesClustering;
  let tokensClusteringIn = 0;
  let tokensClusteringOut = 0;
  for (let b = 0; b < numBatchesClustering; b++) {
    const rowsThisBatch = baseRows + (b < rem ? 1 : 0);
    tokensClusteringIn += countTokens('x'.repeat(promptOverheadChars + rowsThisBatch * (rowLen + 1)));
    tokensClusteringOut += Math.min(2200, 50 * Math.max(1, rowsThisBatch) + 150);
  }
  const usdClustering = (tokensClusteringIn / 1e6) * inputPriceGptPer1m
                      + (tokensClusteringOut / 1e6) * outputPriceGptPer1m;

  // ── Fase Claude: mapeo temáticas → WMAs (1 llamada) ─────────────────────────
  const claudeCatalogTokens = sizes.catalogPromptTokens;
  const estimatedClusters   = Math.min(150, Math.max(15, Math.ceil(nMsg / 4)));
  const claudeClustersTok   = countTokens(Array.from({ length: estimatedClusters }, (_, i) => `Temática simulada ${i + 1}`).join('\n'));
  const claudeInTok         = claudeCatalogTokens + claudeClustersTok + 450;
  const claudeOutTok        = 900;
  const usdClaude = (claudeInTok / 1e6) * inputPriceClaudePer1m
                  + (claudeOutTok / 1e6) * outputPriceClaudePer1m;

  // ── Fase GPT: etiquetado ───────────────────────────────────────────────────
  // En modo hilo el batch baja a 5 conversaciones, el system prompt suma las
  // bases de flujo y fricciones, y la salida deja de ser una etiqueta por ítem:
  // es una por turno más el flujo y las fricciones de la conversación.
  const batchTagging    = isThread ? THREAD_BATCH_TAGGING : BATCH_TAGGING;
  const gptSysTokens    = Math.round(ACTIVE_WMAS * sizes.avgMasterLineTokens) + 150
                        + (isThread ? TAXONOMY_PROMPT_TOKENS : 0);
  const numBatchesGpt   = Math.ceil(nMsg / batchTagging);
  // Cabecera por conversación: origen, número de turnos y aperturas permitidas.
  const gptHeaderPerItem = isThread ? 45 : 0;
  const gptUserPerBatch = Math.ceil((batchTagging * avgChars) / 4) + batchTagging * gptHeaderPerItem;
  const gptOutPerItem   = isThread
    ? turnsPerThread * 40 + 150 // n + code + confidence + evidence por turno; apertura, gestión, desenlace y fricciones por conversación
    : 45;                       // code + confidence + evidence + justification
  const gptOutPerBatch  = batchTagging * gptOutPerItem;
  const gptInTok        = numBatchesGpt * (gptSysTokens + gptUserPerBatch);
  const gptOutTok       = numBatchesGpt * gptOutPerBatch;
  const usdGpt = (gptInTok / 1e6) * inputPriceGptPer1m
               + (gptOutTok / 1e6) * outputPriceGptPer1m;

  // ── Fase WMB (opcional): levantamiento de mensajes "Otros" ──────────────────
  let wmbClusteringInTok = 0, wmbClusteringOutTok = 0, usdWmbClustering = 0;
  let wmbClaudeInTok = 0, wmbClaudeOutTok = 0, usdWmbClaude = 0;
  let wmbGptInTok = 0, wmbGptOutTok = 0, usdWmbGpt = 0;
  let nWmbMsg = 0, wmbBatchesClustering = 0, wmbBatchesGpt = 0, wmbCategories = 0;

  if (includesWmb) {
    nWmbMsg      = Math.max(1, Math.round(nMsg * Math.min(1, Math.max(0, wmbOtrosRate))));
    wmbCategories = wmbNCategories > 0 ? wmbNCategories : 10; // auto → ~10

    // GPT clustering del subconjunto WMA000
    const wmbRowsPerBatch = Math.max(1, Math.floor((CLUSTER_CTX_CHARS - promptOverheadChars) / (rowLen + 1)));
    wmbBatchesClustering  = Math.ceil(nWmbMsg / wmbRowsPerBatch);
    const wmbBaseRows     = Math.floor(nWmbMsg / wmbBatchesClustering);
    const wmbRem          = nWmbMsg % wmbBatchesClustering;
    for (let b = 0; b < wmbBatchesClustering; b++) {
      const rInBatch = wmbBaseRows + (b < wmbRem ? 1 : 0);
      wmbClusteringInTok  += countTokens('x'.repeat(promptOverheadChars + rInBatch * (rowLen + 1)));
      wmbClusteringOutTok += Math.min(1800, 40 * Math.max(1, rInBatch) + 100);
    }
    usdWmbClustering = (wmbClusteringInTok / 1e6) * inputPriceGptPer1m
                     + (wmbClusteringOutTok / 1e6) * outputPriceGptPer1m;

    // Claude: genera categorías emergentes (1 llamada)
    const wmbEstClusters = Math.min(100, Math.max(10, Math.ceil(nWmbMsg / 5)));
    wmbClaudeInTok  = countTokens(Array.from({ length: wmbEstClusters }, (_, i) => `Temática emergente ${i + 1}`).join('\n'))
                    + 600; // overhead del prompt
    wmbClaudeOutTok = wmbCategories * 120; // rootCause + etapa + definición por categoría
    usdWmbClaude    = (wmbClaudeInTok / 1e6) * inputPriceClaudePer1m
                    + (wmbClaudeOutTok / 1e6) * outputPriceClaudePer1m;

    // GPT re-etiquetado del subconjunto WMA000 con el nuevo maestro WMB.
    // Reusa el mismo prompt de hilos, así que arrastra la misma taxonomía.
    const wmbSysTokens  = Math.ceil((wmbCategories * 60) / 4) + 150
                        + (isThread ? TAXONOMY_PROMPT_TOKENS : 0);
    wmbBatchesGpt       = Math.ceil(nWmbMsg / batchTagging);
    const wmbUserPerBatch = Math.ceil((batchTagging * avgChars) / 4) + batchTagging * gptHeaderPerItem;
    const wmbOutPerBatch  = batchTagging * gptOutPerItem;
    wmbGptInTok  = wmbBatchesGpt * (wmbSysTokens + wmbUserPerBatch);
    wmbGptOutTok = wmbBatchesGpt * wmbOutPerBatch;
    usdWmbGpt    = (wmbGptInTok / 1e6) * inputPriceGptPer1m
                 + (wmbGptOutTok / 1e6) * outputPriceGptPer1m;
  }

  const usdWmb   = usdWmbClustering + usdWmbClaude + usdWmbGpt;
  const usdTotal = usdClustering + usdClaude + usdGpt + usdWmb;

  return {
    numMessages:        nMsg,
    analysisMode,
    avgCharsPerMessage: Math.round(avgChars),
    avgTurnsPerThread:  isThread ? turnsPerThread : null,
    batchTagging,
    taxonomyPromptTokens: isThread ? TAXONOMY_PROMPT_TOKENS : 0,
    claudeCatalogTokens,
    gptSysTokens,
    gptOutPerItem,
    numBatchesClustering,
    estimatedClusters,
    numBatchesGpt,
    tokensClusteringIn,
    tokensClusteringOut,
    usdClustering,
    claudeInTok,
    claudeOutTok,
    usdClaude,
    gptInTok,
    gptOutTok,
    usdGpt,
    // WMB
    includesWmb,
    nWmbMsg,
    wmbCategories,
    wmbBatchesClustering,
    wmbClusteringInTok,
    wmbClusteringOutTok,
    usdWmbClustering,
    wmbClaudeInTok,
    wmbClaudeOutTok,
    usdWmbClaude,
    wmbBatchesGpt,
    wmbGptInTok,
    wmbGptOutTok,
    usdWmbGpt,
    usdWmb,
    totalTokens: tokensClusteringIn + tokensClusteringOut + claudeInTok + claudeOutTok + gptInTok + gptOutTok
               + wmbClusteringInTok + wmbClusteringOutTok + wmbClaudeInTok + wmbClaudeOutTok + wmbGptInTok + wmbGptOutTok,
    usdTotal,
    note: `OTBB: GPT-4.1 extrae temáticas, Claude mapea a WMAs existentes y GPT etiqueta en batches de ${batchTagging}.`
        + (isThread
            ? ` Modo hilo: una sola llamada por batch devuelve una etiqueta por turno (${turnsPerThread} en promedio) más flujo y fricciones, y el system prompt carga las bases de flujo y fricciones (~${TAXONOMY_PROMPT_TOKENS} tokens por batch).`
            : '')
        + (includesWmb ? ' Fase WMB: GPT re-levanta los Otros, Claude genera categorías emergentes y GPT re-etiqueta.' : ''),
    prices: { inputPriceClaudePer1m, outputPriceClaudePer1m, inputPriceGptPer1m, outputPriceGptPer1m },
  };
}
