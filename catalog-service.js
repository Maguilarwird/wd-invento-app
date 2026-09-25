import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BANCA_CATALOG_PATH = path.join(__dirname, 'data', 'Catalogo_Banca.json');
// El índice vectorial se arma sobre el mismo catálogo Banca: flattenCatalog ya
// entiende la estructura relacional con registros, así que no hace falta una
// segunda copia del archivo.
const CATALOG_PATH = BANCA_CATALOG_PATH;
const EXCLUSIONS_PATH = path.join(__dirname, 'data', 'Catalogo_exclusiones.json');
const FIELD_DEFINITIONS_PATH = path.join(__dirname, 'data', 'Catalogo_definiciones.json');
const FLOW_DEFINITIONS_PATH = path.join(__dirname, 'data', 'Definiciones_flujo.json');
const FRICTIONS_PATH = path.join(__dirname, 'data', 'Definiciones_fricciones.json');
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'catalog_embeddings.json');

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

let _catalogRoot = null;
let _bancaCatalogRoot = null;
let _exclusionCatalog = null;
let _fieldDefinitionsRoot = null;
let _flowDefinitionsRoot = null;
let _frictionsRoot = null;
let _catalogMtime = 0;
let _bancaCatalogMtime = 0;
let _exclusionCatalogMtime = 0;
let _fieldDefinitionsMtime = 0;
let _flowDefinitionsMtime = 0;
let _frictionsMtime = 0;
let _chunks = [];
let _vectors = null;
let _ready = false;
let _loadingPromise = null;

function loadCatalogRaw() {
  const mtime = fileMtime(CATALOG_PATH);
  if (_catalogRoot && _catalogMtime === mtime) return _catalogRoot;
  if (!fs.existsSync(CATALOG_PATH)) {
    console.warn(`[catalog] no existe ${CATALOG_PATH}, deshabilitado`);
    _catalogRoot = {};
    _catalogMtime = mtime;
    return _catalogRoot;
  }
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  _catalogRoot = JSON.parse(raw);
  _catalogMtime = mtime;
  return _catalogRoot;
}

function loadJsonFile(filePath, fallback, label) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[catalog] no existe ${filePath}, ${label} deshabilitado`);
    return fallback;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function fileMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

function loadBancaCatalogRaw() {
  const mtime = fileMtime(BANCA_CATALOG_PATH);
  if (_bancaCatalogRoot && _bancaCatalogMtime === mtime) return _bancaCatalogRoot;
  _bancaCatalogRoot = loadJsonFile(BANCA_CATALOG_PATH, {}, 'catálogo banca');
  _bancaCatalogMtime = mtime;
  return _bancaCatalogRoot;
}

function loadFieldDefinitionsRaw() {
  const mtime = fileMtime(FIELD_DEFINITIONS_PATH);
  if (_fieldDefinitionsRoot && _fieldDefinitionsMtime === mtime) return _fieldDefinitionsRoot;
  _fieldDefinitionsRoot = loadJsonFile(FIELD_DEFINITIONS_PATH, { Catalogo_Definiciones: { campos: [] } }, 'definiciones');
  _fieldDefinitionsMtime = mtime;
  return _fieldDefinitionsRoot;
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function findBancaBlock(root) {
  if (root?.Catalogo_Banca?.registros) return { key: 'Catalogo_Banca', block: root.Catalogo_Banca };
  const candidates = Object.entries(root || {})
    .filter(([, block]) => block && typeof block === 'object' && Array.isArray(block.registros) && Array.isArray(block.categorias));

  const preferred = candidates.find(([, block]) =>
    (block.registros || []).some(r => r.codigo_tipificacion || r.tipificacion)
  );
  if (preferred) return { key: preferred[0], block: preferred[1] };
  if (candidates[0]) return { key: candidates[0][0], block: candidates[0][1] };
  return { key: null, block: null };
}

export function getBancaMaster() {
  const root = loadBancaCatalogRaw();
  const { key, block } = findBancaBlock(root);
  if (!block) {
    throw new Error('No se encontró un bloque relacional válido en data/Catalogo_Banca.json.');
  }

  const {
    industrias = [],
    segmentos = [],
    macro_productos = [],
    productos = [],
    modulos_journey = [],
    casos_uso = [],
    decision_flows = [],
    categorias = [],
    registros = [],
  } = block;

  const industryMap = Object.fromEntries(industrias.map(i => [i.id, i.nombre]));
  const segmentMap = Object.fromEntries(segmentos.map(s => [s.id, { nombre: s.nombre, industriaId: s.industria_id }]));
  const macroMap = Object.fromEntries(macro_productos.map(m => [m.id, { nombre: m.nombre, segmentoId: m.segmento_id }]));
  const prodMap = Object.fromEntries(productos.map(p => [p.id, { nombre: p.nombre, macroId: p.macro_id || p.macro_producto_id }]));
  const moduleMap = Object.fromEntries(modulos_journey.map(m => [m.id, { nombre: m.nombre, productoId: m.producto_id }]));
  const oldCasoMap = Object.fromEntries(casos_uso.map(c => [c.id, { nombre: c.nombre, prodId: c.producto_id, journey: c.journey }]));
  const decisionMap = Object.fromEntries(decision_flows.map(d => [d.id, { nombre: d.nombre, moduloId: d.modulo_id }]));
  const catMap = Object.fromEntries(categorias.map(c => [c.id, {
    nombre: c.nombre,
    decisionFlowId: c.decision_flow_id,
    casoUsoId: c.caso_uso_id,
  }]));

  // decision_flows → modulos_journey solo tiene rutas completas para Crédito
  // Consumo (MOD-001..006): son los decision_flow que casi todas las demás
  // categorías (Hipotecario, CHIP, Tarjetas, Cuentas...) también referencian,
  // así que la cadena las resuelve como "Crédito Consumo" sin importar de qué
  // producto se trate en realidad (ver metadata desalineada en Etiquetado
  // conversacional/OTBB — ProductoNegocio no coincidía con la Tipificación).
  // El nombre de la categoría SÍ nombra su producto real de forma consistente,
  // así que se usa como fuente primaria; la cadena queda como respaldo para
  // categorías sin nombre de producto explícito en el texto.
  // Variantes en singular que aparecen en algunos nombres de categoría
  // ("Contratación Seguro") aunque el catálogo de productos las nombre en
  // plural ("Seguros").
  const SINGULAR_ALIASES = { seguro: 'seguros' };

  const productsByNameLength = [...productos].sort((a, b) => (b.nombre?.length || 0) - (a.nombre?.length || 0));
  function matchProductoByName(text) {
    const norm = normalizeKey(text)
      .split(' ')
      .map(word => SINGULAR_ALIASES[word] || word)
      .join(' ');
    const hit = productsByNameLength.find(p => p.nombre && norm.includes(normalizeKey(p.nombre)));
    return hit ? { nombre: hit.nombre, macroId: hit.macro_id || hit.macro_producto_id } : null;
  }

  // Categorías genéricas ("Validación de documentación", "Alzamiento de
  // Hipoteca") no nombran el producto en su título, pero la definición del
  // registro casi siempre sí lo hace explícito. Se corta en "No aplica:" para
  // no matchear productos mencionados solo como exclusión.
  function primaryDefinitionText(definicion) {
    return String(definicion || '').split(/no aplica\s*:/i)[0];
  }

  const masterJson = {};
  const metaMap = {};

  registros.forEach(r => {
    const code = r.codigo_tipificacion || r.tipificacion;
    if (!code) return;

    const cat = catMap[r.categoria_id] || {};
    const catNombre = cat.nombre || '';
    const subcategoria = r.subcategoria || r.subcategoria_2 || '';

    const decision = decisionMap[cat.decisionFlowId] || {};
    const journeyModule = moduleMap[decision.moduloId] || {};
    const oldCaso = oldCasoMap[cat.casoUsoId] || {};
    const prod = matchProductoByName(`${catNombre} ${subcategoria} ${primaryDefinitionText(r.definicion)}`)
      || prodMap[journeyModule.productoId || oldCaso.prodId] || {};
    const macro = macroMap[prod.macroId] || {};
    const segment = segmentMap[macro.segmentoId] || {};
    const industry = industryMap[segment.industriaId] || '';

    const def = compactText(r.definicion);

    masterJson[code] = def
      ? `${catNombre} - ${subcategoria} [${def}]`
      : `${catNombre} - ${subcategoria}`.trim();

    metaMap[code] = {
      industria: industry,
      segmento: segment.nombre || r.segmento || '',
      macroProducto: macro.nombre || '',
      producto: prod.nombre || '',
      moduloJourney: journeyModule.nombre || oldCaso.journey || '',
      decisionFlow: decision.nombre || oldCaso.nombre || '',
      casoUso: decision.nombre || oldCaso.nombre || '',
      categoria: catNombre,
      subcategoria,
      tipoInteraccion: r.tipo_interaccion || '',
      etapaComercial: r.etapa_comercial || '',
      areaResponsable: r.area_responsable || '',
      adjuntos: r.adjuntos || '',
      accionIa: r.accion_ia || '',
      capacidadWird: r.capacidad_plataforma || r.capacidad_wird || '',
      beneficio: r.beneficio || '',
      friccion: r.friccion || '',
      sentimiento: r.sentimiento || '',
      notaAlineacion: r.nota_alineacion || '',
      tipo: 'catalogo',
    };
  });

  return { masterJson, metaMap, totalRegistros: registros.length, sourceKey: key };
}

export function getFieldDefinitionsContext({ onlyInUse = true, maxValuesPerField = 60 } = {}) {
  const root = loadFieldDefinitionsRaw();
  const catalog = root.Catalogo_Definiciones || {};
  const campos = Array.isArray(catalog.campos) ? catalog.campos : [];

  const included = campos
    .filter(c => !onlyInUse || c.en_uso !== false)
    // Las categorías del catálogo actual son demasiado numerosas para el prompt WMB;
    // WMB mantiene rootCause libre y usa los demás campos como guía controlada.
    .filter(c => normalizeKey(c.nombre) !== 'categoria')
    .map(c => {
      const valores = Array.isArray(c.valores) ? c.valores.slice(0, maxValuesPerField) : [];
      const valueLines = valores
        .map(v => `  - ${v.valor}: ${compactText(v.definicion)}`)
        .join('\n');
      const omitted = Array.isArray(c.valores) && c.valores.length > valores.length
        ? `\n  - ... (${c.valores.length - valores.length} valores adicionales omitidos para ahorrar tokens)`
        : '';
      return [
        `Campo: ${c.nombre}`,
        `Definición: ${compactText(c.definicion_columna)}`,
        valueLines ? `Valores posibles:\n${valueLines}${omitted}` : '',
      ].filter(Boolean).join('\n');
    });

  return {
    title: catalog.titulo || 'Definiciones de campos',
    description: catalog.descripcion || '',
    context: included.join('\n\n'),
    fieldCount: campos.length,
  };
}

function catIdToWmc(catId) {
  const n = String(catId || '').match(/\d+/)?.[0] || '0';
  return `WMC${String(Number(n)).padStart(3, '0')}`;
}

function loadExclusionCatalogRaw() {
  const mtime = fileMtime(EXCLUSIONS_PATH);
  if (_exclusionCatalog && _exclusionCatalogMtime === mtime) return _exclusionCatalog;
  if (!fs.existsSync(EXCLUSIONS_PATH)) {
    console.warn(`[catalog] no existe ${EXCLUSIONS_PATH}, exclusiones deshabilitadas`);
    _exclusionCatalog = { Catalogo_Exclusiones: { origenes: [], categorias: [], registros: [] } };
    _exclusionCatalogMtime = mtime;
    return _exclusionCatalog;
  }
  const raw = fs.readFileSync(EXCLUSIONS_PATH, 'utf8');
  _exclusionCatalog = JSON.parse(raw);
  _exclusionCatalogMtime = mtime;
  return _exclusionCatalog;
}

export function getExclusionCatalog() {
  const root = loadExclusionCatalogRaw();
  const catalog = root.Catalogo_Exclusiones || {};
  const origenes = Array.isArray(catalog.origenes) ? catalog.origenes : [];
  const categorias = Array.isArray(catalog.categorias) ? catalog.categorias : [];
  const registros = Array.isArray(catalog.registros) ? catalog.registros : [];

  const origenMap = Object.fromEntries(origenes.map(o => [o.id, o.nombre]));
  const catMap = Object.fromEntries(categorias.map(c => [c.id, c]));
  const wmcMeta = {};
  const masterJson = {};

  categorias.forEach(cat => {
    const code = catIdToWmc(cat.id);
    const origen = origenMap[cat.origen_id] || '';
    const defs = registros
      .filter(r => r.categoria_id === cat.id)
      .map(r => String(r.definicion || '').trim())
      .filter(Boolean);
    const definition = [...new Set(defs)][0] || `Exclusión detectada por reglas para ${cat.nombre}.`;

    masterJson[code] = `${cat.nombre} [${definition}]`;
    wmcMeta[code] = {
      categoria: 'Exclusión',
      subcategoria: cat.nombre,
      tipo: 'exclusion',
      origen,
      accionable: registros.some(r => r.categoria_id === cat.id && String(r.trae_senal_accionable || '').toLowerCase().startsWith('s')),
      tratamiento: registros.find(r => r.categoria_id === cat.id)?.tratamiento || 'Etiquetar – ignorable',
    };
  });

  const rules = registros.map(r => {
    const cat = catMap[r.categoria_id] || {};
    const code = catIdToWmc(r.categoria_id);
    return {
      id: r.id,
      code,
      categoria_id: r.categoria_id,
      categoriaNombre: cat.nombre || r.categoria_id,
      origen: origenMap[cat.origen_id] || '',
      texto_contenido: r.texto_contenido || '',
      definicion: r.definicion || '',
      condicion_match: r.condicion_match || '',
      trae_senal_accionable: r.trae_senal_accionable || 'No',
      accionable: String(r.trae_senal_accionable || '').toLowerCase().startsWith('s'),
      tratamiento: r.tratamiento || 'Etiquetar – ignorable',
      indicacion_generativa: r.indicacion_generativa || '',
    };
  });

  return { rules, masterJson, metaMap: wmcMeta, origenes, categorias };
}

// ── Bases de conocimiento de flujo y fricciones ──────────────────────────────

function loadFlowDefinitionsRaw() {
  const mtime = fileMtime(FLOW_DEFINITIONS_PATH);
  if (_flowDefinitionsRoot && _flowDefinitionsMtime === mtime) return _flowDefinitionsRoot;
  _flowDefinitionsRoot = loadJsonFile(FLOW_DEFINITIONS_PATH, { campos: [] }, 'definiciones de flujo');
  _flowDefinitionsMtime = mtime;
  return _flowDefinitionsRoot;
}

function loadFrictionsRaw() {
  const mtime = fileMtime(FRICTIONS_PATH);
  if (_frictionsRoot && _frictionsMtime === mtime) return _frictionsRoot;
  _frictionsRoot = loadJsonFile(FRICTIONS_PATH, { macro_fricciones: [], fricciones: [] }, 'catálogo de fricciones');
  _frictionsMtime = mtime;
  return _frictionsRoot;
}

// Las definiciones traen cifras del mes que se midió ("40% de la base del mes",
// "uno de cada dos avanza"). Enviadas al modelo son anclaje: lo empujan a
// reproducir esa distribución en vez de leer la conversación. Se quitan por
// oración y solo de las definiciones, nunca del nombre del valor, que a veces
// lleva paréntesis legítimos como "(el cliente participa)".
const REPORTING_PATTERNS = [/\d+\s*%/, /\buno de cada\b/i, /\bm[áa]s grande\b/i];

export function stripReportingFigures(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  return raw
    .split(/(?<=\.)\s+/)
    .filter(sentence => !REPORTING_PATTERNS.some(pattern => pattern.test(sentence)))
    .join(' ')
    .trim();
}

// "Outbond" viene así del Excel de origen; el archivo se conserva literal y la
// corrección vive acá.
function normalizeOrigenValue(value) {
  const text = String(value || '').trim();
  if (/^outbo/i.test(text)) return 'Outbound';
  if (/^inbo/i.test(text)) return 'Inbound';
  return text;
}

const FLOW_FIELD_KEYS = {
  'Origen_conversación': 'Origen',
  'Tipo Apertura': 'Apertura',
  'Gestión': 'Gestion',
  'Desenlace': 'Desenlace',
};

export function getFlowDefinitions() {
  const root = loadFlowDefinitionsRaw();
  const campos = Array.isArray(root.campos) ? root.campos : [];

  const fields = campos.map(campo => {
    const key = FLOW_FIELD_KEYS[campo.nombre] || campo.nombre;
    const valores = (Array.isArray(campo.valores) ? campo.valores : []).map(v => ({
      valor: key === 'Origen' ? normalizeOrigenValue(v.valor) : String(v.valor || '').trim(),
      definicion: stripReportingFigures(v.definicion_ia || v.definicion),
    })).filter(v => v.valor);
    return {
      key,
      nombre: campo.nombre,
      definicion: stripReportingFigures(campo.definicion_campo),
      valores,
    };
  });

  const enums = Object.fromEntries(fields.map(f => [f.key, f.valores.map(v => v.valor)]));
  const promptFor = (key) => {
    const field = fields.find(f => f.key === key);
    if (!field) return '';
    const header = field.definicion ? `${field.nombre}: ${field.definicion}` : field.nombre;
    return [header, ...field.valores.map(v => `- ${v.valor}: ${v.definicion}`)].join('\n');
  };

  return {
    fields,
    enums,
    prompts: Object.fromEntries(fields.map(f => [f.key, promptFor(f.key)])),
    version: root.metadata?.version || '',
  };
}

export function getFrictionCatalog() {
  const root = loadFrictionsRaw();
  const macros = Array.isArray(root.macro_fricciones) ? root.macro_fricciones : [];
  const fricciones = (Array.isArray(root.fricciones) ? root.fricciones : []).map(f => ({
    id: String(f.id || '').trim(),
    macroId: String(f.macro_friccion_id || '').trim(),
    macro: String(f.macro_friccion || '').trim(),
    nombre: String(f.nombre || '').trim(),
    senal: stripReportingFigures(f.senal_detectable),
    terminos: Array.isArray(f.terminos_literales) ? f.terminos_literales.filter(Boolean) : [],
  })).filter(f => f.id);

  const prompt = fricciones.map(f => {
    const terminos = f.terminos.length
      ? ` Términos literales: ${f.terminos.map(t => `"${t}"`).join(', ')}.`
      : '';
    return `- ${f.id} [${f.macro}] ${f.nombre}. Señal: ${f.senal}.${terminos}`;
  }).join('\n');

  return {
    macros: macros.map(m => ({ id: m.id, codigo: m.codigo, nombre: m.nombre })),
    fricciones,
    byId: Object.fromEntries(fricciones.map(f => [f.id, f])),
    prompt,
    version: root.metadata?.version || '',
  };
}

// ── Walk ─────────────────────────────────────────────────────────────────────
// Las hojas son arrays de strings (ejemplos). Devolvemos [{path:[...], examples:[...]}]
function walkCategorias(node, pathArr) {
  const out = [];
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every(x => typeof x === 'string')) {
      out.push({ path: pathArr, examples: node });
    }
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push(...walkCategorias(v, [...pathArr, String(k)]));
    }
  }
  return out;
}

function flattenCatalog() {
  const root = loadCatalogRaw();
  const chunks = [];

  for (const [vertical, block] of Object.entries(root)) {
    if (!block || typeof block !== 'object') continue;

    // ── Estructura relacional con registros (Catalogo_Banca) ───────────────────
    // Registros tienen: tipificacion, subcategoria, categoria_id, definicion, ...
    // Categorias: array de {id, nombre, caso_uso_id}
    // Casos de uso: array de {id, nombre, producto_id, journey}
    if (Array.isArray(block.registros) && Array.isArray(block.categorias)) {
      const catMap  = Object.fromEntries((block.categorias || []).map(c => [c.id, c.nombre]));
      const casoMap = Object.fromEntries((block.casos_uso  || []).map(c => [c.id, c.nombre]));
      const catCasoMap = Object.fromEntries((block.categorias || []).map(c => [c.id, c.caso_uso_id]));

      block.registros.forEach(r => {
        if (!r.tipificacion || !r.definicion) return;
        const catNombre  = catMap[r.categoria_id]  || r.categoria_id || '';
        const casoNombre = casoMap[catCasoMap[r.categoria_id]] || '';
        const pathStr    = [catNombre, r.subcategoria].filter(Boolean).join(' > ');
        const def        = (r.definicion || '').replace(/\n/g, ' ').trim();
        const text       = [
          `[Vertical: ${vertical}]`,
          `[Ruta: ${pathStr}]`,
          `[Tipificación: ${r.tipificacion}]`,
          casoNombre ? `[Caso de uso: ${casoNombre}]` : '',
          `Definición: ${def}`,
        ].filter(Boolean).join('\n');

        chunks.push({
          vertical,
          path: pathStr,
          fullPath: `${vertical} > ${pathStr}`,
          topLevel: catNombre,
          tipificacion: r.tipificacion,
          text,
        });
      });
      continue;
    }

    // ── Estructura jerárquica anidada con hojas de string-array (legacy) ───────
    const cats = block.categorias;
    if (!cats || typeof cats !== 'object' || Array.isArray(cats)) continue;
    for (const { path: p, examples } of walkCategorias(cats, [])) {
      const pathStr = p.join(' > ');
      const exLines = examples.filter(Boolean).map(e => `- ${e}`).join('\n');
      const text = `[Vertical: ${vertical}]\n[Ruta: ${pathStr}]\nEjemplos de mensajes tipo cliente:\n${exLines}`;
      chunks.push({
        vertical,
        path: pathStr,
        fullPath: `${vertical} > ${pathStr}`,
        topLevel: p[0] || '',
        text,
      });
    }
  }
  return chunks;
}

// Devuelve el bloque raw del catálogo para una vertical dada.
export function getCatalogBlock(vertical) {
  const root = loadCatalogRaw();
  const availableVerticals = Object.keys(root);
  const block = root[vertical] || null;
  return { block, availableVerticals };
}

// ── Lista de verticales y Categorías Principales (para UI y Levantamiento) ──
export function getVerticalsTree() {
  const root = loadCatalogRaw();
  const out = {};

  for (const [vertical, block] of Object.entries(root)) {
    if (!block || typeof block !== 'object') continue;

    // Normaliza: admite "categorias" (Telefonia/Retail) y
    // "categorias_principales" (Banca/Seguros) como fuente de categorías top-level.
    let cats = block.categorias;
    const usesMainCats = !cats && block.categorias_principales;

    if (usesMainCats) {
      // Banca / Seguros: categorias_principales es un array de {id, nombre}
      const principales = {};
      (block.categorias_principales || []).forEach(cat => {
        const subs = (block.subcategorias_1 || [])
          .filter(s => s.categoria_id === cat.id)
          .map(s => s.nombre);
        principales[cat.nombre] = { subs, examples: [] };
      });
      out[vertical] = principales;
      continue;
    }

    if (!cats || typeof cats !== 'object') continue;

    // Telefonia / Retail: "categorias" es un array de {id, nombre, ...}
    if (Array.isArray(cats)) {
      const principales = {};
      cats.forEach(cat => {
        const subs = (block.registros || [])
          .filter(r => r.categoria_id === cat.id)
          .map(r => r.subcategoria || r.subcategoria_2 || '')
          .filter(Boolean)
          .slice(0, 4);
        principales[cat.nombre] = { subs: [...new Set(subs)], examples: [] };
      });
      out[vertical] = principales;
      continue;
    }

    // Estructura jerárquica anidada (fallback)
    const principales = {};
    for (const [principal, subNode] of Object.entries(cats)) {
      const examples = [];
      const subs = [];
      const stack = [{ node: subNode, pathArr: [] }];
      while (stack.length) {
        const { node, pathArr } = stack.pop();
        if (Array.isArray(node)) {
          if (node.every(x => typeof x === 'string')) {
            examples.push(...node.slice(0, 1));
            if (pathArr.length > 0) subs.push(pathArr.join(' > '));
          }
          continue;
        }
        if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            stack.push({ node: v, pathArr: [...pathArr, k] });
          }
        }
      }
      principales[principal] = { subs, examples: examples.slice(0, 3) };
    }
    out[vertical] = principales;
  }
  return out;
}

// ── Embeddings con batching ──────────────────────────────────────────────────
async function embedBatch(texts) {
  const response = await axios.post(
    'https://api.openai.com/v1/embeddings',
    { model: EMBEDDING_MODEL, input: texts },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_KEY}` },
      timeout: 120000,
    }
  );
  const data = response.data.data.slice().sort((a, b) => a.index - b.index);
  return data.map(d => d.embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

function catalogMtime() {
  try { return fs.statSync(CATALOG_PATH).mtimeMs; } catch { return 0; }
}

function readCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(obj) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (e) {
    console.warn('[catalog] no se pudo guardar cache:', e.message);
  }
}

export async function ensureCatalogIndex() {
  if (_ready) return;
  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    const chunks = flattenCatalog();
    if (chunks.length === 0) {
      _chunks = [];
      _vectors = null;
      _ready = true;
      return;
    }

    const mtime = catalogMtime();
    const cached = readCache();
    if (cached && cached.mtime === mtime && cached.model === EMBEDDING_MODEL &&
        Array.isArray(cached.chunks) && cached.chunks.length === chunks.length) {
      _chunks = cached.chunks;
      _vectors = cached.vectors;
      _ready = true;
      console.log(`[catalog] cache cargada (${_chunks.length} chunks)`);
      return;
    }

    if (!process.env.OPENAI_KEY) {
      console.warn('[catalog] sin OPENAI_KEY, el RAG de catálogo queda sin vectores');
      _chunks = chunks;
      _vectors = null;
      _ready = true;
      return;
    }

    console.log(`[catalog] indexando ${chunks.length} chunks con ${EMBEDDING_MODEL}...`);
    const BATCH = 64;
    const allVectors = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH).map(c => c.text);
      const vectors = await embedBatch(slice);
      allVectors.push(...vectors);
    }

    _chunks = chunks;
    _vectors = allVectors;
    _ready = true;
    writeCache({ mtime, model: EMBEDDING_MODEL, chunks, vectors: allVectors });
    console.log(`[catalog] indexados ${chunks.length} chunks`);
  })();

  try {
    await _loadingPromise;
  } finally {
    _loadingPromise = null;
  }
}

export async function searchCatalog(query, { topK = 5, vertical = null } = {}) {
  await ensureCatalogIndex();
  if (!_chunks.length || !_vectors) return [];

  const [qVec] = await embedBatch([query]);
  const pool = _chunks
    .map((chunk, i) => ({ chunk, score: cosine(qVec, _vectors[i]) }))
    .filter(({ chunk }) => !vertical || chunk.vertical === vertical);

  pool.sort((a, b) => b.score - a.score);
  return pool.slice(0, topK).map(({ chunk, score }) => ({
    fullPath: chunk.fullPath,
    vertical: chunk.vertical,
    path: chunk.path,
    topLevel: chunk.topLevel,
    tipificacion: chunk.tipificacion || '',
    score,
    snippet: chunk.text.slice(0, 800),
  }));
}

// Lanza el indexado en background al importar (sin bloquear).
export function warmupCatalogIndex() {
  ensureCatalogIndex().catch(e => console.warn('[catalog] warmup falló:', e.message));
}
