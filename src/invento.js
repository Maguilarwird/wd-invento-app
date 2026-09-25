import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import axios from 'axios';
import prompts from './prompts.json';
import { API_BASE } from './config';

const OTBB_CLUSTER_CONTEXT_SIZE = 12000;
const OTBB_CLUSTER_TIMEOUT_MS = 300000;
const OTBB_MAX_ACTIVE_WMAS = 45;

function batchTextsForContext(promptInstruction, texts, contextSize = 30000) {
  const separator = "\n";
  const baseTokens = promptInstruction.length + separator.length;
  const finalBatches = [];
  let currentBatch = [];
  let currentBatchTokens = baseTokens;

  for (const datum of texts) {
    if (typeof datum !== 'string' || datum.trim() === '') continue;
    const datumTokens = datum.length + separator.length;
    if (currentBatchTokens + datumTokens <= contextSize) {
      currentBatch.push(datum);
      currentBatchTokens += datumTokens;
    } else {
      finalBatches.push(currentBatch);
      currentBatch = [datum];
      currentBatchTokens = baseTokens + datumTokens;
    }
  }

  if (currentBatch.length > 0) finalBatches.push(currentBatch);
  return finalBatches;
}

function buildOtbbCatalogLines(masterJson, metaMap) {
  return Object.entries(masterJson)
    .map(([code, value]) => {
      const meta = metaMap?.[code] || {};
      const path = [
        meta.macroProducto,
        meta.producto,
        meta.casoUso,
        meta.categoria,
        meta.subcategoria,
      ].filter(Boolean).join(' > ');
      return `${code}: ${value}${path ? `\nRuta: ${path}` : ''}`;
    })
    .join('\n\n');
}

function parseClaudeOtbbMapping(text, masterJson) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const rawCodes = Array.isArray(parsed.selected_codes) ? parsed.selected_codes : [];
      const selectedCodes = rawCodes
        .map(item => typeof item === 'string' ? item : item?.code)
        .map(code => String(code || '').trim())
        .filter(code => masterJson[code] || code === 'WMA000');
      const mappings = rawCodes.map(item => typeof item === 'string' ? { code: item } : item);
      return { selectedCodes, mappings };
    } catch {
      // ponytail: fallback regex recupera códigos si Claude rompe JSON; si necesitamos auditoría fina, pedir tool-use.
    }
  }

  const selectedCodes = [...new Set((String(text || '').match(/WMA\d{3}|WMA000/g) || []))]
    .filter(code => masterJson[code] || code === 'WMA000');
  return {
    selectedCodes,
    mappings: selectedCodes.map(code => ({ code, rationale: 'Recuperado desde respuesta no-JSON de Claude.' })),
  };
}

function parseClusterToolArgs(args) {
  try {
    const parsed = JSON.parse(args || '{"clusters":[]}');
    return Array.isArray(parsed.clusters) ? parsed.clusters : [];
  } catch {
    // ponytail: recover useful strings from truncated tool JSON; upgrade path is server-side tool streaming/retry.
    const raw = String(args || '');
    const arrayMatch = raw.match(/"clusters"\s*:\s*\[([\s\S]*)/);
    const source = arrayMatch ? arrayMatch[1] : raw;
    const recovered = [];
    const re = /"((?:\\.|[^"\\]){8,240})"/g;
    let match;
    while ((match = re.exec(source)) && recovered.length < 40) {
      const text = match[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, ' ')
        .trim();
      if (text && !['clusters'].includes(text)) recovered.push(text);
    }
    return recovered;
  }
}

/**
 * Open The Black Box: reutiliza la lógica de levantamiento en dos pasos:
 * 1) GPT extrae temáticas desde la muestra.
 * 2) Claude mapea esas temáticas a códigos WMA existentes en Catalogo_Banca.
 */
export async function generateCatalogMappedMaster({
  texts,
  masterJson,
  metaMap,
  companyType = 'Banca',
  setProgress = () => {},
  isCancelled = () => false,
  signal,
}) {
  const validTexts = Array.isArray(texts)
    ? texts.map(t => String(t || '').trim()).filter(Boolean)
    : [];
  if (validTexts.length === 0) {
    return {
      masterJson: { WMA000: 'Otros (ninguna categoría aplica)' },
      selectedCodes: ['WMA000'],
      clusters: [],
      mappings: [],
    };
  }

  const promptInstruction = prompts.CLUSTERING_1.CORREO?.PROMPT;
  const funcSpec = prompts.CLUSTERING_1.CORREO?.FUNC;
  if (!promptInstruction || !funcSpec) {
    throw new Error('Prompt de clustering CORREO no disponible para OTBB.');
  }

  // ponytail: chunks smaller than Levantamiento avoid 120s browser-side timeouts; if datasets grow much more, move this phase server-side.
  const chunks = batchTextsForContext(promptInstruction, validTexts, OTBB_CLUSTER_CONTEXT_SIZE);
  const globalClusters = new Set();
  setProgress(1);

  for (let index = 0; index < chunks.length; index++) {
    if (isCancelled()) throw new Error('CANCELLED');
    const userInput = promptInstruction
      .replace("{0}", companyType)
      .replace("{1}", chunks[index].join("\n"));

    const otbbInstruction = `${userInput}

IMPORTANTE PARA OTBB:
- Devuelve máximo 30 temáticas por chunk.
- Cada temática debe ser breve (máximo 12 palabras).
- No incluyas ejemplos ni explicaciones dentro de cada temática.`;

    const response = await axios.post(`${API_BASE}/proxy/openai`, {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: otbbInstruction }],
      tools: [{
        type: 'function',
        function: {
          name: 'clusterize',
          description: funcSpec.DESC,
          parameters: {
            type: 'object',
            properties: {
              clusters: {
                type: 'array',
                items: { type: 'string' },
                description: funcSpec.ARRAY_DESC,
              },
            },
            required: ['clusters'],
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'clusterize' } },
      temperature: 0,
      max_tokens: 1800,
    }, { timeout: OTBB_CLUSTER_TIMEOUT_MS, signal });

    const args = response.data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    parseClusterToolArgs(args).forEach(cluster => {
      if (typeof cluster === 'string' && cluster.trim()) globalClusters.add(cluster.trim());
    });
    setProgress(Math.round(((index + 1) / chunks.length) * 100));
  }

  const clusters = [...globalClusters];
  if (clusters.length === 0) {
    throw new Error('No se generaron temáticas para mapear contra el catálogo.');
  }

  const catalogLines = buildOtbbCatalogLines(masterJson, metaMap);
  const clusterLines = clusters.map((cluster, i) => `${i + 1}. ${cluster}`).join('\n');

  const prompt = `Eres un experto en taxonomía bancaria y clasificación de mensajes de clientes.
Tu tarea es construir el maestro aplicable a una muestra a partir de temáticas extraídas por GPT.

REGLA CRÍTICA:
- Solo puedes usar códigos WMA existentes del catálogo.
- No inventes códigos, nombres ni categorías.
- Si una temática no encaja con suficiente claridad, asígnala a WMA000.
- Selecciona únicamente códigos que aparezcan representados en las temáticas de la muestra.

CATÁLOGO BANCA:
${catalogLines}

WMA000: Otros (ninguna categoría aplica claramente)

TEMÁTICAS EXTRAÍDAS DE LA MUESTRA:
${clusterLines}

Responde ÚNICAMENTE con JSON válido simple. No incluyas objetos anidados ni explicaciones:
{
  "selected_codes": ["WMA001", "WMA006", "WMA000"]
}`;

  const response = await axios.post(`${API_BASE}/proxy/anthropic`, {
    model: 'claude-sonnet-5',
    max_tokens: 5000,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: 300000, signal });

  const text = response.data?.content?.[0]?.text || '';
  const { selectedCodes: parsedCodes, mappings } = parseClaudeOtbbMapping(text, masterJson);
  const selectedCodes = [];
  parsedCodes.forEach(item => {
    const code = String(item || '').trim();
    if ((masterJson[code] || code === 'WMA000') && !selectedCodes.includes(code)) {
      selectedCodes.push(code);
    }
  });

  if (!selectedCodes.includes('WMA000')) selectedCodes.push('WMA000');

  if (selectedCodes.length > OTBB_MAX_ACTIVE_WMAS) {
    const withoutOtros = selectedCodes.filter(code => code !== 'WMA000').slice(0, OTBB_MAX_ACTIVE_WMAS - 1);
    selectedCodes.length = 0;
    selectedCodes.push(...withoutOtros, 'WMA000');
  }

  const activeMaster = {};
  selectedCodes.forEach(code => {
    activeMaster[code] = code === 'WMA000'
      ? 'Otros (ninguna categoría aplica claramente)'
      : masterJson[code];
  });

  return {
    masterJson: activeMaster,
    selectedCodes,
    clusters,
    mappings,
  };
}

/**
 * Sub-flujo WMB: levanta categorías emergentes desde los mensajes clasificados como "Otros" (WMA000).
 * Usa GPT para extraer temáticas y Claude para generar Root Cause + Etapa + Definición.
 * Devuelve { masterJson, metaMap } con códigos WMB001, WMB002, ...
 */
export async function generateEmergentCategories({
  texts,
  companyType = 'Banca',
  medium = 'CORREO',
  nCategories = 0,   // 0 = automático (IA decide)
  setProgress = () => {},
  isCancelled = () => false,
  signal,
}) {
  const validTexts = Array.isArray(texts)
    ? texts.map(t => String(t || '').trim()).filter(Boolean)
    : [];
  if (validTexts.length === 0) return { masterJson: {}, metaMap: {} };

  const promptKey = ['CORREO', 'RRSS', 'ENCUESTA', 'AUDIO'].includes(medium.toUpperCase())
    ? medium.toUpperCase()
    : 'CORREO';

  const promptInstruction = prompts.CLUSTERING_1[promptKey]?.PROMPT;
  const funcSpec           = prompts.CLUSTERING_1[promptKey]?.FUNC;
  if (!promptInstruction || !funcSpec) throw new Error(`Prompt no disponible para origen "${promptKey}"`);

  // ── Fase A: GPT extrae temáticas ────────────────────────────────────────────
  const chunks = batchTextsForContext(promptInstruction, validTexts, OTBB_CLUSTER_CONTEXT_SIZE);
  const globalClusters = new Set();
  setProgress(1);

  for (let i = 0; i < chunks.length; i++) {
    if (isCancelled()) throw new Error('CANCELLED');

    const userInput = promptInstruction
      .replace('{0}', companyType)
      .replace('{1}', chunks[i].join('\n'));

    const instruction = `${userInput}

IMPORTANTE: Devuelve máximo 30 temáticas por bloque. Cada temática: máximo 12 palabras, sin ejemplos.`;

    const resp = await axios.post(`${API_BASE}/proxy/openai`, {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: instruction }],
      tools: [{
        type: 'function',
        function: {
          name: 'clusterize',
          description: funcSpec.DESC,
          parameters: {
            type: 'object',
            properties: { clusters: { type: 'array', items: { type: 'string' }, description: funcSpec.ARRAY_DESC } },
            required: ['clusters'],
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'clusterize' } },
      temperature: 0,
      max_tokens: 1800,
    }, { timeout: OTBB_CLUSTER_TIMEOUT_MS, signal });

    parseClusterToolArgs(resp.data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments)
      .forEach(c => { if (typeof c === 'string' && c.trim()) globalClusters.add(c.trim()); });

    setProgress(Math.round(((i + 1) / chunks.length) * 50));
  }

  const clusters = [...globalClusters];
  if (clusters.length === 0) throw new Error('No se generaron temáticas para los mensajes Otros.');

  let fieldDefinitionsContext = '';
  try {
    const { data } = await axios.get(`${API_BASE}/api/catalog/field-definitions`, {
      params: { onlyInUse: true, maxValuesPerField: 80 },
      signal,
      timeout: 30000,
    });
    fieldDefinitionsContext = data?.context || '';
  } catch (e) {
    console.warn('No se pudo cargar Catalogo_definiciones para WMB:', e.message);
  }

  // ── Fase B: Claude genera Root Cause + Etapa + Definición ───────────────────
  setProgress(55);
  const clusterLines = clusters.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const catLimit = nCategories > 0
    ? `COMO MÁXIMO ${nCategories} categorías emergentes. No estás obligado a usar todo el cupo.`
    : 'Las categorías que sean necesarias, máximo 20. Si no hay temáticas suficientemente representativas, devuelve cero categorías.';

  const claudePrompt = `Eres un experto en análisis de comunicaciones de clientes de ${companyType}.
A continuación tienes temáticas extraídas de mensajes que NO pudieron clasificarse en el catálogo principal.
Tu tarea es consolidarlas en ${catLimit.toLowerCase()} con definición estructurada y campos del maestro alineados.

CATÁLOGO DE DEFINICIONES DE CAMPOS:
${fieldDefinitionsContext || 'No disponible. Usa criterio experto y marca "N/A" si no puedes inferir un campo.'}

TEMÁTICAS:
${clusterLines}

Para cada categoría emergente devuelve un JSON con esta estructura EXACTA:
{
  "categorias": [
    {
      "rootCause": "Nombre breve (verbo + objeto, ej: 'Reclamo por acceso a app')",
      "industria": "valor del catálogo o N/A",
      "segmento": "valor del catálogo o N/A",
      "macroProducto": "valor del catálogo o N/A",
      "producto": "valor del catálogo o N/A",
      "moduloJourney": "valor del catálogo o N/A",
      "decisionFlow": "valor del catálogo o N/A",
      "tipoInteraccion": "valor del catálogo o N/A",
      "etapa": "valor del catálogo o N/A",
      "areaResponsable": "valor del catálogo o N/A",
      "adjuntos": "SI, NO o N/A",
      "capacidadPlataforma": "uno o más valores del catálogo separados por ; o N/A",
      "sentimiento": "valor del catálogo o N/A",
      "definicion": "El cliente [verbo] [acción concreta con criterio limítrofe]. Ejemplo: \\"frase 1\\", \\"frase 2\\", \\"frase 3\\". No aplica: \\"caso excluido 1\\", \\"caso excluido 2\\", \\"caso excluido 3\\"."
    }
  ]
}

Si ninguna temática justifica una categoría emergente, responde exactamente:
{ "categorias": [] }

REGLAS:
- Consolida temáticas similares en una sola categoría.
- ${catLimit}
- Crea categorías solo para temáticas recurrentes, representativas o accionables sobre el total.
- No crees categorías para ruido, casos aislados, mensajes de baja frecuencia o temáticas demasiado heterogéneas; esos mensajes deben quedar como "Otros" en el re-etiquetado posterior.
- No inventes categorías para completar el número configurado.
- Para los campos del maestro, usa preferentemente valores presentes en el catálogo de definiciones. Si no hay encaje claro, usa "N/A"; no inventes valores nuevos.
- El campo "rootCause" debe ser conciso (máximo 8 palabras).
- La "definicion" sigue la plantilla de definición estructurada con "El cliente", Ejemplo y No aplica.
- Responde ÚNICAMENTE con el JSON. Sin texto adicional.`;

  const claudeResp = await axios.post(`${API_BASE}/proxy/anthropic`, {
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: claudePrompt }],
  }, { timeout: 300000, signal });

  setProgress(85);

  const claudeText = claudeResp.data?.content?.[0]?.text || '';
  const jsonMatch  = claudeText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude no devolvió JSON válido para categorías emergentes.');

  let categorias = [];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    categorias = Array.isArray(parsed.categorias) ? parsed.categorias : [];
  } catch {
    throw new Error('Error parseando JSON de categorías emergentes de Claude.');
  }

  if (categorias.length === 0) {
    setProgress(100);
    return { masterJson: {}, metaMap: {}, clusters };
  }

  // ── Construir masterJson y metaMap WMB ──────────────────────────────────────
  const masterJson = {};
  const metaMap    = {};

  categorias.forEach((cat, idx) => {
    const code       = `WMB${String(idx + 1).padStart(3, '0')}`;
    const rootCause  = String(cat.rootCause  || `Categoría emergente ${idx + 1}`).trim();
    const etapa      = String(cat.etapa      || 'Sin etapa').trim();
    const definicion = String(cat.definicion || '').trim();

    masterJson[code] = definicion
      ? `Sugerida por IA - ${rootCause} [${definicion}]`
      : `Sugerida por IA - ${rootCause}`;

    metaMap[code] = {
      industria:       String(cat.industria || 'N/A').trim(),
      segmento:        String(cat.segmento || 'N/A').trim(),
      macroProducto:   String(cat.macroProducto || 'N/A').trim(),
      producto:        String(cat.producto || 'N/A').trim(),
      moduloJourney:   String(cat.moduloJourney || '').trim(),
      decisionFlow:    String(cat.decisionFlow || '').trim(),
      casoUso:         String(cat.decisionFlow || '').trim(),
      categoria:       'Sugerida por IA',
      subcategoria:    rootCause,
      tipoInteraccion: String(cat.tipoInteraccion || '').trim(),
      etapaComercial:  etapa,
      areaResponsable: String(cat.areaResponsable || '').trim(),
      journey:         String(cat.moduloJourney || '').trim(),
      adjuntos:        String(cat.adjuntos || '').trim(),
      capacidadWird:   String(cat.capacidadPlataforma || '').trim(),
      sentimiento:     String(cat.sentimiento || '').trim(),
      tipo:            'emergente',
    };
  });

  setProgress(100);
  return { masterJson, metaMap, clusters };
}

export class Invento {
  constructor(medium, file, textColumn, companyType, email, nCategories, analysisMode = 'tematico') {
    this.medium = medium.toUpperCase().replace(" ", "_");
    this.file = file;
    this.textColumn = textColumn;
    this.companyType = companyType;
    this.email = email;
    this.nCategories = nCategories;
    this.analysisMode = analysisMode;
    this.df = null;
    this.clusters = {};
    this.prompts = prompts;
  }

  async loadData(file) {
    return new Promise((resolve, reject) => {
      try {
        if (!file || !file.name) {
          console.error("Archivo inválido:", file);
          reject(new Error("Archivo no válido."));
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          reject(new Error("Archivo demasiado grande (máximo 10MB)."));
          return;
        }

        if (file.name.toLowerCase().endsWith(".xls")) {
          reject(new Error("Formato .xls (Excel 97-2003) no soportado. Guarda el archivo como .xlsx e inténtalo de nuevo."));
        } else if (file.name.endsWith(".csv")) {
          Papa.parse(file, {
            complete: (result) => {
              try {
                this.df = this.preprocess(result.data);
                console.log(`${this.df.length} datos cargados.`);
                resolve();
              } catch (e) {
                reject(e);
              }
            },
            header: true,
            skipEmptyLines: true,
            encoding: 'UTF-8'
          });
        } else if (file.name.endsWith(".xlsx")) {
          const reader = new FileReader();
          reader.onload = async (e) => {
            try {
              const buffer = e.target.result;
              const workbook = new ExcelJS.Workbook();
              await workbook.xlsx.load(buffer);
              const worksheet = workbook.worksheets[0];
              const json = [];
              worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                if (rowNumber === 1) return;
                const rowData = {};
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                  const header = worksheet.getRow(1).getCell(colNumber).value;
                  rowData[header] = cell.value;
                });
                json.push(rowData);
              });
              this.df = this.preprocess(json);
              console.log(`${this.df.length} datos cargados.`);
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          reader.onerror = () => {
            reject(reader.error);
          };
          reader.readAsArrayBuffer(file);
        } else {
          reject(new Error("Formato de archivo no soportado."));
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  preprocess(data) {
    if (!Array.isArray(data)) {
      throw new Error("Datos de entrada no válidos.");
    }
    const cleaned = data
      .map(row => {
        const value = row[this.textColumn];
        return {
          ...row,
          [this.textColumn]: String(value || '').replace(/nan/i, '').replace(/\xa0/g, ' ')
        };
      })
      .filter(row => {
        const isValid = row[this.textColumn]?.trim() !== '';
        if (!isValid) {
          console.warn("Fila ignorada (valor vacío):", row);
        }
        return isValid;
      });

    if (cleaned.length === 0) {
      throw new Error("No se han cargado datos válidos. Verifica tu columna seleccionada.");
    }

    return cleaned;
  }

  batchForClustering(promptInstruction, queries, contextSize = 40000) {
    const separator = "\n";
    const baseTokens = promptInstruction.length + separator.length;
    let finalBatches = [];
    let currentBatch = [];
    let currentBatchTokens = baseTokens;

    for (const datum of queries) {
      if (typeof datum !== 'string') continue;
      const datumTokens = datum.length + separator.length;
      if (currentBatchTokens + datumTokens <= contextSize) {
        currentBatch.push(datum);
        currentBatchTokens += datumTokens;
      } else {
        finalBatches.push(currentBatch);
        currentBatch = [datum];
        currentBatchTokens = baseTokens + datumTokens;
      }
    }

    if (currentBatch.length > 0) {
      finalBatches.push(currentBatch);
    }

    return finalBatches;
  }

async generateClusters(setProgress, isCancelled = () => false, catalogReference = null, setPhase = () => {}) {
    if (!this.df || !Array.isArray(this.df)) {
      throw new Error("No se han cargado datos válidos.");
    }

    const data = this.df.map(row => row[this.textColumn]);
    const promptInstruction = this.prompts.CLUSTERING_1[this.medium]?.PROMPT;

    if (!promptInstruction) {
      throw new Error(`Prompt no encontrado para medio "${this.medium}"`);
    }

    const chunks = this.batchForClustering(promptInstruction, data, 30000);
    let globalClusters = new Set();
    let tokens = 0;
    let lastProcessedChunkIndex = -1;

    setPhase({ step: 1, total: 3, label: 'Extrayendo temáticas' });

    for (let index = 0; index < chunks.length; index++) {
      if (isCancelled()) throw new Error('CANCELLED');
      if (index <= lastProcessedChunkIndex) continue;

      const currentChunk = chunks[index];
      const userInput = promptInstruction
        .replace("{0}", this.companyType)
        .replace("{1}", currentChunk.join("\n"));

      try {
        const response = await axios.post(`${API_BASE}/proxy/openai`, {
          model: "gpt-4.1",
          messages: [{ role: "user", content: userInput }],
          tools: [{
            type: "function",
            function: {
              name: "clusterize",
              description: this.prompts.CLUSTERING_1[this.medium].FUNC.DESC,
              parameters: {
                type: "object",
                properties: {
                  clusters: {
                    type: "array",
                    items: { type: "string" },
                    description: this.prompts.CLUSTERING_1[this.medium].FUNC.ARRAY_DESC
                  }
                },
                required: ["clusters"]
              }
            }
          }],
          tool_choice: { type: "function", function: { name: "clusterize" } }
        }, {
          timeout: 120000
        });

        const completion = response.data;
        const replyContent = JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments);

        tokens += completion.usage?.prompt_tokens || 0 + (completion.usage?.completion_tokens || 0) * 3;
        replyContent.clusters.forEach(cluster => globalClusters.add(cluster));
        lastProcessedChunkIndex = index;
        setProgress(((index + 1) / chunks.length) * 100);
        console.log(`Chunk ${index} - Éxito ✅`);

      } catch (e) {
        console.error(`Chunk ${index} - Fallo ❌:`, e.message);
      }
    }

    if (globalClusters.size === 0) {
      console.error("❌ No se generaron clusters. Verifica:");
      console.error("- Que el prompt esté devolviendo datos válidos");
      console.error("- Que los chunks no estén vacíos");
      console.error("- Que la API esté funcionando correctamente");
      throw new Error("No se generaron clusters. Proceso detenido.");
    }

    console.log("Temáticas extraídas con éxito!", [...globalClusters]);

    setPhase({ step: 2, total: 3, label: 'Generando categorías con Claude' });
    console.log("\n[FASE 2] Generando categorías con Claude...");
    const categoriesText = await this.claudeCategories([...globalClusters], this.companyType, this.nCategories, catalogReference);
    if (!categoriesText || categoriesText.trim().length === 0) {
      throw new Error("Claude no devolvió categorías. Revisa la consola del servidor.");
    }
    console.log("[FASE 2] ✅ Claude respondió. Formateando JSON...");

    setPhase({ step: 3, total: 3, label: 'Formateando JSON' });
    const categoriesJsonString = await this.jsonFormatterGpt(categoriesText);
    if (!categoriesJsonString || categoriesJsonString.trim().length === 0) {
      throw new Error("El formatter de JSON devolvió una respuesta vacía.");
    }
    console.log("[FASE 3] ✅ JSON formateado. Parseando...");

    const categoriesJson = JSON.parse(categoriesJsonString);

    const categoryCount = Object.keys(categoriesJson).length;
    if (this.nCategories > 0 && categoryCount !== this.nCategories) {
      console.warn(`⚠️ Se solicitaron ${this.nCategories} categorías pero se recibieron ${categoryCount}`);
    }

    let newData = {};
    let counter = 1;

    for (const [category, elements] of Object.entries(categoriesJson)) {
      for (const element of elements) {
        const code = `WMA${counter.toString().padStart(3, '0')}`;
        newData[code] = element;
        counter++;
      }
    }

    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const year = today.getFullYear();
    const formattedDate = `${month}${day}${year}`;

    let sentiments = null;
    if (this.analysisMode === 'sentiment') {
      try {
        console.log('\nClasificando sentimientos con Claude...');
        sentiments = await this.getSentiments(newData);
        console.log('Sentimientos clasificados ✅');
      } catch (e) {
        console.warn('⚠️ Clasificación de sentimientos falló:', e.message);
      }
    }

    return {
      flat: newData,
      hierarchy: categoriesJson,
      sentiments,
      analysisMode: this.analysisMode,
      sampleSize: this.df?.length ?? 0,
      generatedDateStr: formattedDate,
    };
  }

  getSentiments(flatJson) {
    const lines = Object.entries(flatJson)
      .map(([code, label]) => `${code}: ${label}`)
      .join('\n');

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios.post(`${API_BASE}/proxy/anthropic`, {
          model: 'claude-sonnet-5',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: `Clasifica el sentimiento predominante del cliente para cada categoría de comunicación.
Considera: "positivo" = satisfacción, agradecimiento, consulta proactiva de mejora; "neutro" = solicitud informativa sin carga emocional clara; "negativo" = reclamo, frustración, insatisfacción, urgencia.

Responde ÚNICAMENTE con un JSON válido donde las claves son los códigos WMA y los valores son exactamente "positivo", "neutro" o "negativo". Sin texto adicional.

Categorías:
${lines}

JSON:`,
          }],
        }, { timeout: 90000 });

        const text = response.data.content[0].text.trim();
        const match = text.match(/\{[\s\S]*\}/);
        resolve(JSON.parse(match ? match[0] : text));
      } catch (e) {
        reject(e);
      }
    });
  }

  claudeCategories(catList, companyType, nTematicas, catalogReference = null) {
    const catalogBlock = catalogReference
      ? `\nCATÁLOGO DE REFERENCIA DEL SECTOR (úsalo como guía para nombrar y agrupar categorías, pero NO estás obligado a seguirlo si los datos del cliente no encajan):\n${catalogReference}\n`
      : '';

    const definitionInstructions = `
DEFINICIONES: Para cada subcategoría debes agregar una definición estructurada entre corchetes [] inmediatamente después del nombre, siguiendo esta plantilla EXACTA:

[Fórmula (El cliente + verbo + acción concreta, con criterio/requisito que distingue casos limítrofes). Ejemplo: "frase representativa 1", "frase representativa 2", "frase representativa 3". No aplica: "caso similar excluido 1", "caso excluido 2", "caso excluido 3".]

Reglas de la plantilla:
- La fórmula SIEMPRE empieza con "El cliente" seguido de un verbo explícito (reclama, solicita, consulta, reporta, cancela...).
- La descripción debe incluir el criterio interno que distingue este caso de otros similares (ej. "habiendo pagado en fecha", "sin haber recibido el producto").
- Los Ejemplos son exactamente 3 frases generales, entre comillas, separadas por comas. No deben ser demasiado específicas.
- El "No aplica" es obligatorio: incluye exactamente 3 casos similares que la categoría NO cubre, para evitar confusión. Nunca solo 1.
- La definición completa (dentro de los corchetes) debe ser concisa. No uses listas ni saltos de línea dentro de los corchetes.

Ejemplo correcto de subcategoría con definición:
Reclamo por Corte de Luz [El cliente reclama por un corte de suministro eléctrico en su hogar, habiendo pagado su cuenta en la fecha acordada o dentro del período de gracia. Ejemplo: "me cortaron la luz y tengo el comprobante de pago", "llevo dos días sin luz y pagué ayer", "me cortaron sin aviso previo y estoy al día". No aplica: "cliente consulta cuándo vence su factura", "cliente solicita información sobre tarifas eléctricas", "cliente reporta una caída de voltaje sin corte total".]
`;

    const baseInstructions = `Debes nombrar los clusters y subclusters con un nombre muy breve que empiece con un verbo que explicite la razón del comunicado, por ejemplo: 'Reclamo por Pago no Reflejado', 'Solicitud de Crédito de Consumo', 'Problema con ingreso a la plataforma'. Los nombres deben ser específicos y detallar bien la casuística, en pocas palabras.`;

    const prompt = nTematicas == 0
      ? `
A continuación te mostraré una lista de temáticas de correos de clientes a su ejecutivo de ${companyType}. Este resultado está sucio, ya que contiene temáticas similares, temáticas duplicadas y temáticas irrelevantes. Tu tarea es agruparlas como si fuese un algoritmo de clustering y reducir a no menos de 10 temáticas esta lista sin perder información relevante. Solo debes crear un cluster si la cantidad de temáticas es relevante. ${baseInstructions}
${catalogBlock}
${definitionInstructions}

Temáticas a agrupar: ${catList.join(", ")}
`
      : `
A continuación te mostraré una lista de temáticas de correos de clientes a su ejecutivo de ${companyType}. Este resultado está sucio, ya que contiene temáticas similares, temáticas duplicadas y temáticas irrelevantes. Tu tarea es agruparlas como si fuese un algoritmo de clustering y reducir esta lista a exactamente ${nTematicas} temáticas sin perder información relevante. ${baseInstructions}

IMPORTANTE: El resultado DEBE tener EXACTAMENTE ${nTematicas} categorías principales, ni más ni menos. Cada categoría debe tener un MÁXIMO de 4 subcategorías. Antes de responder, verifica que sean exactamente ${nTematicas} categorías principales.
${catalogBlock}
${definitionInstructions}

Temáticas a agrupar: ${catList.join(", ")}
`;

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios.post(`${API_BASE}/proxy/anthropic`, {
          model: "claude-sonnet-5",
          max_tokens: 8000,
          messages: [{ role: "user", content: prompt.trim() }]
        }, {
          timeout: 300000
        });

        resolve(response.data.content[0].text);
      } catch (e) {
        console.error("Error con Claude:", e.message);
        reject(e);
      }
    });
  }

  jsonFormatterGpt(text) {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios.post(`${API_BASE}/proxy/openai`, {
          model: "gpt-4.1",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Eres un sistema que formatea textos en formato JSON. Debes formatear el texto de categorías y subcategorías en el siguiente formato:
{
  "Categoría 1": ["Subcategoría 1 [definición entre corchetes]", "Subcategoría 2 [definición entre corchetes]"],
  "Categoría 2": ["Subcategoría 3 [definición entre corchetes]"],
  "Otros": ["Sin clasificar"]
}

REGLAS CRÍTICAS:
1. Cada subcategoría debe conservar ÍNTEGRAMENTE su definición entre corchetes [] tal como aparece en el texto original. NO la omitas, NO la modifiques, NO la acortes.
2. El contenido dentro de los corchetes puede contener comillas — respétalas sin alterarlas (escápalas como \\\" si es necesario para JSON válido).
3. Si una subcategoría no tiene definición entre corchetes, consérvala tal cual.
4. Devuelve ÚNICAMENTE el JSON, sin texto adicional.`
            },
            { role: "user", content: text }
          ]
        }, {
          timeout: 300000
        });

        resolve(response.data.choices[0].message.content);
      } catch (e) {
        console.error("Error al formatear JSON:", e.message);
        reject(e);
      }
    });
  }

  downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}