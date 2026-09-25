import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import axios from 'axios';
import { API_BASE } from './config.js';
import {
  PROD_SAMPLE_DEFAULT,
  selectDeterministicSampleIndices,
} from './etiquetado-sampling.js';

export {
  PROD_SAMPLE_DEFAULT,
  PROD_SAMPLE_MAX,
  selectDeterministicSampleIndices,
} from './etiquetado-sampling.js';

const OTHERS_CODES = new Set(['WMA000', 'WMA010']);

// UI modelMode → OpenAI model name
const MODEL_MAP = {
  prod: 'gpt-4.1',
  gpt:  'gpt-5.2',
};

// Items per API call (batch classification)
export const BATCH_SIZE = 12;
// Concurrent batch workers
const CONCURRENCY = 15;

export class Etiquetado {
  constructor() {
    this.data = null;
    this.categorias = {};
    this.textColumn = '';
    this.expertVertical = null;
  }

  /**
   * Carga y procesa un archivo CSV o Excel
   */
  async loadData(file, textColumn) {
    return new Promise((resolve, reject) => {
      if (!file || !file.name) return reject(new Error("Archivo inválido."));
      if (file.size > 10 * 1024 * 1024) return reject(new Error("El archivo es demasiado grande (máximo 10MB)."));

      this.textColumn = textColumn;

      if (file.name.toLowerCase().endsWith(".xls")) {
        reject(new Error("Formato .xls (Excel 97-2003) no soportado. Guarda el archivo como .xlsx e inténtalo de nuevo."));
      } else if (file.name.endsWith(".csv")) {
        Papa.parse(file, {
          complete: (result) => {
            try {
              this.data = this.preprocess(result.data);
              resolve();
            } catch (e) { reject(e); }
          },
          header: true,
          skipEmptyLines: true,
          encoding: 'utf-8'
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
            this.data = this.preprocess(json);
            resolve();
          } catch (err) { reject(err); }
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      } else {
        reject(new Error("Formato de archivo no soportado."));
      }
    });
  }

  /**
   * Preprocesa los datos: preserva el texto original (incluidos emojis, tildes y
   * símbolos) y conserva TODAS las filas para no perder registros. Solo se aplica
   * una limpieza ligera (trim + remoción de caracteres de control invisibles).
   */
  preprocess(data) {
    if (!Array.isArray(data)) throw new Error("Datos no válidos.");

    const cleanText = (value) => {
      if (value == null) return '';
      // Extrae texto real de celdas tipo objeto (rich text / fórmula / hipervínculo)
      let str;
      if (typeof value === 'object') {
        if (Array.isArray(value.richText)) str = value.richText.map(r => r.text).join('');
        else if (value.result != null) str = String(value.result);
        else if (value.text != null) str = String(value.text);
        else if (value.hyperlink != null) str = String(value.text ?? value.hyperlink);
        else str = String(value);
      } else {
        str = String(value);
      }
      // Limpieza ligera: quita caracteres de control invisibles y recorta espacios.
      // Preserva emojis, tildes y todo el Unicode visible.
      return str.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    };

    const cleaned = data.map(row => {
      const normalizedRow = {};
      Object.keys(row).forEach(key => { normalizedRow[key] = cleanText(row[key]); });
      return normalizedRow;
    });

    if (cleaned.length === 0) throw new Error("El archivo no contiene filas de datos.");
    return cleaned;
  }

  /**
   * Carga las categorías desde un archivo JSON
   */
  loadCategorias(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          this.setCategorias(JSON.parse(reader.result));
          resolve();
        } catch {
          reject(new Error("Archivo de categorías inválido."));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, 'utf-8');
    });
  }

  setCategorias(categorias) {
    if (!categorias || typeof categorias !== 'object' || Array.isArray(categorias)) {
      throw new Error("Archivo de categorías inválido.");
    }
    const cleaned = {};
    for (const [code, name] of Object.entries(categorias)) {
      if (typeof name !== 'string') {
        throw new Error(`La categoría "${code}" debe tener un nombre en texto.`);
      }
      cleaned[code] = name;
    }
    if (Object.keys(cleaned).length === 0) {
      throw new Error("El maestro de categorías está vacío.");
    }
    this.categorias = cleaned;
  }

  setExpertVertical(vertical) {
    this.expertVertical = vertical || null;
  }

  // ── Prompt builders ──────────────────────────────────────────────────────────

  _categoriesStr() {
    const entries = Object.entries(this.categorias);
    const hasOtros = entries.some(([code]) => code === 'WMA000');
    const base = entries.map(([code, name]) => `${code}: ${name}`).join('\n');
    return hasOtros ? base : `${base}\nWMA000: Otros (ninguna categoría aplica)`;
  }

  _buildSingleSystemPrompt(ignoreStr, deriveStr) {
    const optional = [];
    if (ignoreStr) optional.push(`    - Si el mensaje presenta alguna de estas frases/palabras (sin importar mayúsculas/minúsculas ni faltas de ortografía): ${ignoreStr} — responde automáticamente WMI000 con value=1 (y justification/evidence/confidence) y todas las demás claves con value=0.`);
    if (deriveStr) optional.push(`    - Si el mensaje presenta alguna de estas frases/palabras (sin importar mayúsculas/minúsculas ni faltas de ortografía): ${deriveStr} — responde automáticamente WMD000 con value=1 (y justification/evidence/confidence) y todas las demás claves con value=0.`);
    const optionalBlock = optional.length ? '\n' + optional.join('\n') : '';

    return `Eres un asistente que clasifica mensajes de clientes en una única categoría.

### Categorías Disponibles ###
${this._categoriesStr()}

### Instrucciones ###
- Analiza el mensaje y selecciona la categoría MÁS relevante.
- Los nombres entre corchetes ([]) son definiciones adicionales; úsalas para mayor precisión.
- Si ninguna categoría encaja claramente con el mensaje, selecciona WMA000 (Otros). No fuerces una categoría que no corresponde.
- Responde ÚNICAMENTE con un JSON donde cada clave es un código de categoría:
    - La categoría seleccionada (value=1): incluye "value", "evidence" (lista de fragmentos literales del texto), "justification" (una oración breve) y "confidence" (número 0.0-1.0 basado en qué tan bien encajan la evidencia y la definición).
    - Todas las demás (value=0): solo "value": 0.${optionalBlock}
- SOLO UNA categoría puede tener value=1.
- No agregues comentarios ni formato adicional fuera del JSON.

Ejemplo de respuesta válida:
{
    "WMA001": {"value": 1, "evidence": ["texto exacto del mensaje"], "justification": "El cliente reporta un cargo duplicado.", "confidence": 0.95},
    "WMA002": {"value": 0},
    "WMA003": {"value": 0}
}`;
  }

  _buildMultiSystemPrompt(ignoreStr, deriveStr) {
    const optional = [];
    if (ignoreStr) optional.push(`    - Si el mensaje presenta alguna de estas frases/palabras (sin importar mayúsculas/minúsculas ni faltas de ortografía): ${ignoreStr} — responde automáticamente WMI000 con value=1 y todas las demás claves con value=0.`);
    if (deriveStr) optional.push(`    - Si el mensaje presenta alguna de estas frases/palabras (sin importar mayúsculas/minúsculas ni faltas de ortografía): ${deriveStr} — responde automáticamente WMD000 con value=1 y todas las demás claves con value=0.`);
    const optionalBlock = optional.length ? '\n' + optional.join('\n') : '';

    return `Eres un asistente que clasifica mensajes de clientes en múltiples categorías.

### Categorías Disponibles ###
${this._categoriesStr()}

### Instrucciones ###
- Analiza el mensaje y selecciona TODAS las categorías relevantes (máximo 4).
- Los nombres entre corchetes ([]) son definiciones adicionales; úsalas para mayor precisión.
- Si hay más de 4 categorías relevantes, prioriza las 4 más importantes.
- Si ninguna categoría encaja claramente, selecciona WMA000 (Otros). No fuerces categorías que no corresponden.
- Responde ÚNICAMENTE con un JSON donde cada clave es un código de categoría:
    - Las categorías seleccionadas (value=1): incluye "value", "evidence" (fragmentos literales), "justification" (una oración) y "confidence" (0.0-1.0 basado en qué tan bien encajan evidencia y definición).
    - Las demás (value=0): solo "value": 0.${optionalBlock}
- No agregues comentarios ni formato adicional fuera del JSON.

Ejemplo de respuesta válida:
{
    "WMA001": {"value": 1, "evidence": ["cobro duplicado"], "justification": "El cliente reporta un cargo repetido.", "confidence": 0.9},
    "WMA004": {"value": 1, "evidence": ["quiero cancelar"], "justification": "El cliente solicita cancelación del servicio.", "confidence": 0.8},
    "WMA002": {"value": 0},
    "WMA003": {"value": 0}
}`;
  }

  /**
   * Prompt para clasificar N mensajes en una sola llamada.
   * La respuesta es un JSON con claves "0".."N-1", cada una con el objeto de clasificación.
   */
  _buildBatchSystemPrompt(batchSize, taggingMode, ignoreStr, deriveStr) {
    const optional = [];
    if (ignoreStr) optional.push(`    - Si un mensaje presenta alguna de estas frases/palabras: ${ignoreStr} — responde automáticamente WMI000 con value=1 y todas las demás claves con value=0.`);
    if (deriveStr) optional.push(`    - Si un mensaje presenta alguna de estas frases/palabras: ${deriveStr} — responde automáticamente WMD000 con value=1 y todas las demás claves con value=0.`);
    const optionalBlock = optional.length ? '\n' + optional.join('\n') : '';

    const modeInstruction = taggingMode === 'multi'
      ? 'selecciona TODAS las categorías relevantes (máximo 4). Si ninguna encaja, usa WMA000.'
      : 'selecciona la categoría MÁS relevante (exactamente 1). Si ninguna encaja, usa WMA000.';

    return `Eres un asistente que clasifica mensajes de clientes.

### Categorías Disponibles ###
${this._categoriesStr()}

### Instrucciones ###
Recibirás ${batchSize} mensajes numerados del [0] al [${batchSize - 1}].
Para CADA mensaje: ${modeInstruction}
- Los nombres entre corchetes ([]) son definiciones adicionales; úsalas para mayor precisión.
- Responde ÚNICAMENTE con un JSON con claves "0" a "${batchSize - 1}":
    - La(s) categoría(s) seleccionada(s) (value=1): incluye "value", "evidence" (fragmentos literales), "justification" (una oración) y "confidence" (0.0-1.0).
    - Las demás (value=0): solo "value": 0.
- Cada entrada debe contener TODAS las claves de categoría.
- No agregues comentarios ni formato adicional fuera del JSON.${optionalBlock}

Ejemplo de respuesta JSON para 2 mensajes:
{
  "0": {"WMA001": {"value": 1, "evidence": ["texto"], "justification": "El cliente reporta cargo.", "confidence": 0.9}, "WMA002": {"value": 0}},
  "1": {"WMA002": {"value": 1, "evidence": ["otro texto"], "justification": "Solicita baja.", "confidence": 0.8}, "WMA001": {"value": 0}}
}`;
  }

  _getValue(entry) {
    if (entry && typeof entry === 'object') return entry.value === 1 ? 1 : 0;
    return entry === 1 ? 1 : 0;
  }

  _cleanName(name) {
    return String(name).replace(/\s*\[[^\]]*\]\s*/g, '').trim();
  }

  _emptyFallback() {
    return { categorias: ['WMA000 - Otros'], assignments: [], confidence: 0, primaryCode: 'WMA000' };
  }

  /**
   * Parsea el objeto de clasificación de OpenAI para un único mensaje.
   */
  _parseClassification(responseJson, taggingMode) {
    if (!responseJson || typeof responseJson !== 'object') return this._emptyFallback();

    const expectedCodes = Object.keys(this.categorias);

    if (this._getValue(responseJson.WMI000) === 1) {
      const entry = responseJson.WMI000;
      return {
        categorias: ['WMI000 - Ignorar'],
        assignments: [{ code: 'WMI000', name: 'Ignorar', evidence: Array.isArray(entry?.evidence) ? entry.evidence : [], justification: entry?.justification ?? 'Coincide con una frase de ignorar configurada.', confidence: Number(entry?.confidence ?? 1) }],
        confidence: Number(entry?.confidence ?? 1),
        primaryCode: 'WMI000',
      };
    }
    if (this._getValue(responseJson.WMD000) === 1) {
      const entry = responseJson.WMD000;
      return {
        categorias: ['WMD000 - Derivar'],
        assignments: [{ code: 'WMD000', name: 'Derivar', evidence: Array.isArray(entry?.evidence) ? entry.evidence : [], justification: entry?.justification ?? 'Coincide con una frase de derivar configurada.', confidence: Number(entry?.confidence ?? 1) }],
        confidence: Number(entry?.confidence ?? 1),
        primaryCode: 'WMD000',
      };
    }

    const selected = [];
    for (const code of expectedCodes) {
      const entry = responseJson[code];
      if (this._getValue(entry) !== 1) continue;
      selected.push({
        code,
        name: this._cleanName(this.categorias[code]),
        evidence: Array.isArray(entry?.evidence) ? entry.evidence : [],
        justification: typeof entry?.justification === 'string' ? entry.justification : '',
        confidence: Number(entry?.confidence ?? 0),
      });
    }

    if (selected.length === 0) return this._emptyFallback();

    const trimmed = taggingMode === 'multi' ? selected.slice(0, 4) : [selected[0]];
    return {
      categorias: trimmed.map(a => `${a.code} - ${a.name}`),
      assignments: trimmed,
      confidence: trimmed[0]?.confidence ?? 0,
      primaryCode: trimmed[0]?.code ?? 'WMA000',
    };
  }

  /**
   * Clasifica un único texto (fallback / uso individual).
   */
  async classifyText(text, taggingMode = 'single', ignorePhrases = [], derivePhrases = [], modelMode = 'prod') {
    const model = MODEL_MAP[modelMode] ?? 'gpt-4.1';
    const isProd = modelMode === 'prod';

    const ignoreStr = Array.isArray(ignorePhrases) && ignorePhrases.length > 0 ? ignorePhrases.join(', ') : null;
    const deriveStr = Array.isArray(derivePhrases) && derivePhrases.length > 0 ? derivePhrases.join(', ') : null;

    const systemPrompt = taggingMode === 'single'
      ? this._buildSingleSystemPrompt(ignoreStr, deriveStr)
      : this._buildMultiSystemPrompt(ignoreStr, deriveStr);

    const userPrompt = `### Mensaje ###\n${text}\n\n### JSON categorias: `;

    try {
      const body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        ...(isProd && { temperature: 0, max_tokens: 1536 }),
      };

      const response = await axios.post(`${API_BASE}/proxy/openai`, body, { timeout: 120000 });
      const content = response.data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') return this._emptyFallback();

      let responseJson;
      try { responseJson = JSON.parse(content.trim()); } catch { return this._emptyFallback(); }

      return this._parseClassification(responseJson, taggingMode);
    } catch (e) {
      const detail = e.response?.data?.error?.message ?? e.response?.data?.error ?? e.message;
      throw new Error(`Modelo ${model}: ${detail}`);
    }
  }

  /**
   * Clasifica un lote de textos en una única llamada a la API.
   * Retorna un array de clasificaciones en el mismo orden que `texts`.
   */
  async _classifyBatch(texts, taggingMode, ignorePhrases, derivePhrases, modelMode) {
    const model = MODEL_MAP[modelMode] ?? 'gpt-4.1';
    const isProd = modelMode === 'prod';
    const batchSize = texts.length;

    const ignoreStr = ignorePhrases?.length > 0 ? ignorePhrases.join(', ') : null;
    const deriveStr = derivePhrases?.length > 0 ? derivePhrases.join(', ') : null;

    const systemPrompt = this._buildBatchSystemPrompt(batchSize, taggingMode, ignoreStr, deriveStr);
    const messagesBlock = texts.map((t, i) => `[${i}]: ${t}`).join('\n');
    const userPrompt = `### Mensajes ###\n${messagesBlock}\n\n### JSON respuesta batch:`;

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      ...(isProd && { temperature: 0, max_tokens: Math.min(1536 * batchSize, 8192) }),
    };

    const response = await axios.post(`${API_BASE}/proxy/openai`, body, { timeout: 180000 });
    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Respuesta batch vacía');

    const totalTokens = response.data?.usage?.total_tokens ?? 0;
    const tokensPerItem = batchSize > 0 ? Math.round(totalTokens / batchSize) : 0;

    const batchJson = JSON.parse(content.trim());

    return texts.map((_, i) => {
      const itemJson = batchJson[String(i)];
      return { ...this._parseClassification(itemJson, taggingMode), tokensUsed: tokensPerItem };
    });
  }

  /**
   * Solicita sugerencias expertas (RAG sobre Catálogo_Categorías.json) para un texto.
   */
  async fetchCatalogSuggestions(text) {
    try {
      const response = await axios.post(`${API_BASE}/api/catalog/suggestions`, {
        text,
        vertical: this.expertVertical || undefined,
        topK: 3,
      }, { timeout: 60000 });
      return Array.isArray(response.data?.suggestions) ? response.data.suggestions : [];
    } catch (e) {
      console.warn('No se pudieron obtener sugerencias expertas:', e.message);
      return [];
    }
  }

  _buildProdResult(item, index, payload, taggingMode) {
    let categorias;
    let masterWarning = '';

    if (taggingMode === 'single') {
      categorias = Array.isArray(payload?.categorias) ? payload.categorias : [];
    } else {
      const responseCodes = Object.keys(payload || {})
        .filter(code => payload[code] === 0 || payload[code] === 1);
      const localCodes = Object.keys(this.categorias);
      const unknownCodes = responseCodes.filter(code => !this.categorias[code]);
      const missingCodes = localCodes.filter(code => !responseCodes.includes(code));
      if (unknownCodes.length > 0 || missingCodes.length > 0) {
        masterWarning = [
          unknownCodes.length > 0 ? `códigos solo en producción: ${unknownCodes.join(', ')}` : '',
          missingCodes.length > 0 ? `códigos solo en archivo local: ${missingCodes.join(', ')}` : '',
        ].filter(Boolean).join(' · ');
      }
      categorias = responseCodes
        .filter(code => payload[code] === 1)
        .map(code => `${code} - ${this.categorias[code] ? this._cleanName(this.categorias[code]) : 'Código no presente en maestro local'}`);
    }

    if (categorias.length === 0) categorias = ['WMA000 - Otros'];
    const assignments = categorias.map((category) => {
      const separator = category.indexOf(' - ');
      return {
        code: separator >= 0 ? category.slice(0, separator) : category,
        name: separator >= 0 ? category.slice(separator + 3) : '',
        evidence: [],
        justification: '',
        confidence: 0,
      };
    });

    return {
      ...item,
      CategoriaAsignada: categorias.join('; '),
      Justificacion: 'Clasificación directa del servicio productivo.',
      Evidencia: '',
      Confianza: Number(payload?.confidence) || 0,
      TokensConsumidos: 0,
      SugerenciasExpertas: '',
      FuenteEtiquetado: 'multitag-api',
      EstadoEtiquetado: 'success',
      AdvertenciaMaestro: masterWarning,
      MuestraIndiceOriginal: index + 1,
      _assignments: assignments,
      _suggestions: [],
      _source: 'multitag-api',
      _status: 'success',
    };
  }

  async runProdSample(
    setProgress,
    taggingMode,
    client,
    sampleSize = PROD_SAMPLE_DEFAULT,
    isCancelled = () => false,
  ) {
    if (!this.data || !Array.isArray(this.data)) throw new Error('No se han cargado datos.');
    if (!client) throw new Error('Selecciona un cliente productivo.');
    if (taggingMode === 'multi' && Object.keys(this.categorias).length === 0) {
      throw new Error('Carga el maestro de categorías para traducir la respuesta MultiTag.');
    }

    const sampleIndices = selectDeterministicSampleIndices(this.data.length, sampleSize);
    const resultsByIndex = new Map();
    const requestItems = [];

    for (const index of sampleIndices) {
      const item = this.data[index];
      const text = String(item?.[this.textColumn] ?? '').trim();
      if (!text) {
        resultsByIndex.set(index, {
          ...item,
          CategoriaAsignada: 'WMA000 - Otros',
          Justificacion: 'Texto vacío — fallback local sin llamada al servicio.',
          Evidencia: '',
          Confianza: 0,
          TokensConsumidos: 0,
          SugerenciasExpertas: '',
          FuenteEtiquetado: 'fallback-local',
          EstadoEtiquetado: 'empty',
          MuestraIndiceOriginal: index + 1,
          _assignments: [],
          _suggestions: [],
          _source: 'fallback-local',
          _status: 'empty',
          _empty: true,
        });
      } else {
        requestItems.push({ index, text });
      }
    }

    setProgress(requestItems.length === 0 ? 100 : 10);
    if (isCancelled()) throw new Error('CANCELLED');

    let responseData = {
      endpoint: taggingMode === 'single' ? '/tag_single' : '/tag_only',
      requested: 0,
      succeeded: 0,
      failed: 0,
      results: [],
      source: 'multitag-api',
    };

    if (requestItems.length > 0) {
      const controller = new AbortController();
      const cancelWatcher = setInterval(() => {
        if (isCancelled()) controller.abort();
      }, 100);
      try {
        const response = await axios.post(
          `${API_BASE}/api/etiquetado/prod-sample`,
          { items: requestItems, client, taggingMode },
          { timeout: 15 * 60 * 1000, signal: controller.signal },
        );
        responseData = response.data;
      } catch (error) {
        if (controller.signal.aborted || error.code === 'ERR_CANCELED') {
          throw new Error('CANCELLED');
        }
        throw error;
      } finally {
        clearInterval(cancelWatcher);
      }
    }

    if (isCancelled()) throw new Error('CANCELLED');

    for (const result of responseData.results || []) {
      const item = this.data[result.index];
      if (result.ok) {
        resultsByIndex.set(
          result.index,
          this._buildProdResult(item, result.index, result.data, taggingMode),
        );
      } else {
        resultsByIndex.set(result.index, {
          ...item,
          CategoriaAsignada: 'ERROR',
          Justificacion: result.error || 'Error técnico en multitag-api.',
          Evidencia: '',
          Confianza: 0,
          TokensConsumidos: 0,
          SugerenciasExpertas: '',
          FuenteEtiquetado: 'multitag-api',
          EstadoEtiquetado: 'technical_error',
          MuestraIndiceOriginal: result.index + 1,
          _assignments: [],
          _suggestions: [],
          _source: 'multitag-api',
          _status: 'technical_error',
          _error: result.error || 'Error técnico en multitag-api.',
        });
      }
    }

    setProgress(100);
    return {
      rows: sampleIndices.map(index => resultsByIndex.get(index)),
      meta: {
        source: 'multitag-api',
        client,
        endpoint: responseData.endpoint,
        datasetRows: this.data.length,
        sampleRows: sampleIndices.length,
        estimatedCalls: requestItems.length,
        succeeded: responseData.succeeded,
        failed: responseData.failed,
        empty: sampleIndices.length - requestItems.length,
      },
    };
  }

  /**
   * Procesa todos los registros usando un pool de CONCURRENCY workers de batch.
   * Cada worker toma BATCH_SIZE ítems por llamada a la API.
   */
  async runEtiquetado(setProgress, taggingMode = 'single', ignorePhrases = [], derivePhrases = [], modelMode = 'prod', isCancelled = () => false) {
    if (!this.data || !Array.isArray(this.data)) throw new Error("No se han cargado datos.");
    if (Object.keys(this.categorias).length === 0) throw new Error("No se han cargado categorías.");

    const total = this.data.length;
    const results = new Array(total);
    let nextIndex = 0;
    let completed = 0;

    const buildResult = (item, classification, sugerencias) => {
      const justificaciones = classification.assignments
        .filter(a => a.justification)
        .map(a => `${a.code}: ${a.justification}`)
        .join(' | ');

      const evidencias = classification.assignments
        .filter(a => a.evidence?.length > 0)
        .map(a => `${a.code}: ${a.evidence.map(e => `"${e}"`).join(', ')}`)
        .join(' | ');

      const sugerenciasStr = sugerencias
        .map(s => `${s.catalogPath} (match ${(s.matchStrength ?? 0).toFixed(2)}): ${s.rationale || ''}`)
        .join(' | ');

      return {
        ...item,
        CategoriaAsignada: classification.categorias.join('; '),
        Justificacion: justificaciones,
        Evidencia: evidencias,
        Confianza: Number.isFinite(classification.confidence) ? classification.confidence : 0,
        TokensConsumidos: classification.tokensUsed ?? 0,
        SugerenciasExpertas: sugerenciasStr,
        _assignments: classification.assignments,
        _suggestions: sugerencias,
      };
    };

    const worker = async () => {
      while (true) {
        if (isCancelled()) throw new Error('CANCELLED');
        // Toma el próximo batch de forma atómica
        const batchStart = nextIndex;
        nextIndex += BATCH_SIZE;
        if (batchStart >= total) return;

        const batchIndices = Array.from(
          { length: Math.min(BATCH_SIZE, total - batchStart) },
          (_, i) => batchStart + i
        );

        // Separa filas con texto vacío: se conservan en el output marcadas como
        // VACÍO, sin llamar a la API (no se pierden registros ni se gastan tokens).
        const emptyIndices = [];
        const validIndices = [];
        for (const idx of batchIndices) {
          const text = String(this.data[idx][this.textColumn] ?? '').trim();
          if (text === '') emptyIndices.push(idx);
          else validIndices.push(idx);
        }

        for (const idx of emptyIndices) {
          results[idx] = {
            ...this.data[idx],
            CategoriaAsignada: 'VACÍO',
            Justificacion: 'Texto vacío — no se envió al modelo.',
            Evidencia: '',
            Confianza: 0,
            TokensConsumidos: 0,
            SugerenciasExpertas: '',
            _assignments: [],
            _suggestions: [],
            _empty: true,
          };
        }

        if (validIndices.length === 0) {
          completed += batchIndices.length;
          setProgress(Math.round((completed / total) * 100));
          continue;
        }

        const validTexts = validIndices.map(idx => this.data[idx][this.textColumn]);

        let classifications;
        try {
          classifications = await this._classifyBatch(validTexts, taggingMode, ignorePhrases, derivePhrases, modelMode);
        } catch (e) {
          for (const idx of validIndices) {
            results[idx] = {
              ...this.data[idx],
              CategoriaAsignada: 'ERROR',
              Justificacion: e.message || String(e),
              Evidencia: '',
              Confianza: 0,
              SugerenciasExpertas: '',
              _assignments: [],
              _suggestions: [],
              _error: e.message || String(e),
            };
          }
          completed += batchIndices.length;
          setProgress(Math.round((completed / total) * 100));
          continue;
        }

        // Procesa cada ítem válido del batch (sugerencias expertas por ítem si aplica)
        await Promise.all(validIndices.map(async (idx, i) => {
          const item = this.data[idx];
          const classification = classifications[i] ?? this._emptyFallback();

          let sugerencias = [];
          if (classification.assignments.length === 0 || OTHERS_CODES.has(classification.primaryCode)) {
            sugerencias = await this.fetchCatalogSuggestions(item[this.textColumn]);
          }

          results[idx] = buildResult(item, classification, sugerencias);
        }));

        completed += batchIndices.length;
        setProgress(Math.round((completed / total) * 100));
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.ceil(total / BATCH_SIZE)) }, () => worker()));
    return results;
  }
}
