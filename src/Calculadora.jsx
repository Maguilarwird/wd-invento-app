import { useState } from 'react';
import axios from 'axios';
import { API_BASE } from './config';

// Catálogo de modelos y precios de lista (USD por 1M tokens), input / output.
//
// Solo los modelos que esta app puede correr de verdad. El criterio, para que
// se pueda mantener sin adivinar:
//
//   - `wired`: el modelo está cableado en el código (selector de OTBB o de
//     etiquetado, o una llamada fija). `where` dice dónde, para poder
//     verificarlo.
//   - `env`: no está cableado, pero se puede usar hoy cambiando solo una
//     variable de entorno (CLAUDE_MODEL / GEMINI_MODEL en server.js), sin
//     tocar código. Sirve para cotizar un cambio de modelo antes de hacerlo.
//
// Los modelos de OpenAI NO se pueden cambiar por entorno: las listas son
// literales en el código (OpenBlackBox.jsx MODEL_OPTIONS, etiquetado.js
// MODEL_MAP), así que agregar uno es un cambio de código y no se lista acá
// hasta que exista.
const MODEL_CATALOG = [
  // ── OpenAI (todos cableados) ──────────────────────────────────────────────
  { id: 'gpt-4.1',           label: 'GPT-4.1',                       provider: 'OpenAI', in: 2.00, out: 8.00,  use: 'wired', where: 'OTBB · etiquetado prod · invento · server' },
  { id: 'gpt-4.1-mini',      label: 'GPT-4.1-mini',                  provider: 'OpenAI', in: 0.40, out: 1.60,  use: 'wired', where: 'Anonimizador' },
  { id: 'gpt-5.2',           label: 'GPT-5.2',                       provider: 'OpenAI', in: 1.75, out: 14.00, use: 'wired', where: 'OTBB · etiquetado (modo gpt)' },
  { id: 'gpt-5.6-luna',      label: 'GPT-5.6-luna',                  provider: 'OpenAI', in: 0.20, out: 1.20,  use: 'wired', where: 'OTBB' },
  // Mismo modelo, tramo de contexto largo: en OTBB los transcripts de hilo son
  // justo lo que empuja hacia ese tramo, y ahí el precio se duplica.
  { id: 'gpt-5.6-luna-long', label: 'GPT-5.6-luna (contexto largo)', provider: 'OpenAI', in: 0.40, out: 1.80,  use: 'wired', where: 'OTBB, contexto largo' },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  { id: 'claude-sonnet-5',   label: 'Claude Sonnet 5',               provider: 'Anthropic', in: 2.00, out: 10.00, use: 'wired', where: 'default de /proxy/anthropic · OTBB · invento' },
  { id: 'claude-haiku-4.5',  label: 'Claude Haiku 4.5',              provider: 'Anthropic', in: 1.00, out: 5.00,  use: 'wired', where: 'Anonimizador' },
  { id: 'claude-opus-5',     label: 'Claude Opus 5',                 provider: 'Anthropic', in: 5.00, out: 25.00, use: 'env',   where: 'CLAUDE_MODEL' },
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6',             provider: 'Anthropic', in: 3.00, out: 15.00, use: 'env',   where: 'CLAUDE_MODEL (generación anterior)' },

  // ── Google ────────────────────────────────────────────────────────────────
  { id: 'gemini-3.5-flash',  label: 'Gemini 3.5 Flash',              provider: 'Google', in: 0.30, out: 2.50, use: 'wired', where: 'segundo juez de AutoQA' },
];

const getModel = (id) => MODEL_CATALOG.find((m) => m.id === id) ?? MODEL_CATALOG[0];

// Constantes del Anonimizador (extraídas del repo)
const ANON = {
  systemPromptTokens: 730,    // DEFAULT_PROMPT ≈ 540 words
  userOverheadTokens: 150,    // instrucción de batch + JSON wrapper
  maxBatchRecords:     20,
  maxBatchChars:    40_000,
  inputCharsPerToken:   4,    // ~4 chars = 1 token
  outputCharsPerToken: 3.5,   // output ≈ input length (placeholders similares)
};

const DEFAULT_CATEGORIAS = `{
  "WMA001": "Consulta de producto",
  "WMA002": "Reclamo de servicio",
  "WMA003": "Solicitud de información"
}`;

const QA_DEFAULT_CATEGORIAS = `{
  "WMA001": "Consulta de producto [El cliente pregunta por características, disponibilidad o precio de un producto. Ejemplo: \\"¿tienen stock del modelo X?\\". No aplica: reclamos por un producto ya comprado.]",
  "WMA002": "Reclamo de servicio [El cliente expresa molestia por una falla en la atención o el servicio recibido. Ejemplo: \\"llevo días esperando respuesta\\". No aplica: consultas informativas.]",
  "WMA003": "Solicitud de información [El cliente pide datos de su cuenta, estado de un trámite o información general. Ejemplo: \\"¿cuál es el estado de mi pedido?\\".]"
}`;

function fmtUsd(n, digits = 6) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `USD ${Number(n).toFixed(digits)}`;
}

function fmtNum(n, digits = 0) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('es-CL', { maximumFractionDigits: digits });
}

function Card({ children, className = '' }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-xl shadow-sm p-5 mb-5 ${className}`}>
      {children}
    </div>
  );
}

function FieldLabel({ children, hint }) {
  return (
    <label className="block text-sm font-medium text-gray-700 mb-1">
      {children}
      {hint && <span className="ml-1 font-normal text-gray-400 text-xs">({hint})</span>}
    </label>
  );
}

function Input({ className = '', ...props }) {
  return (
    <input
      className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#22eda3]/50 focus:border-[#22eda3] ${className}`}
      {...props}
    />
  );
}

function Select({ className = '', children, ...props }) {
  return (
    <select
      className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#22eda3]/50 focus:border-[#22eda3] ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

function Textarea({ className = '', ...props }) {
  return (
    <textarea
      className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#22eda3]/50 focus:border-[#22eda3] resize-y ${className}`}
      {...props}
    />
  );
}

function FileBtn({ label, onChange }) {
  return (
    <label className="mt-2 inline-flex items-center gap-1.5 cursor-pointer text-xs text-[#171433] border border-[#171433]/30 rounded-lg px-3 py-1.5 hover:bg-[#171433]/5 transition-colors">
      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
      </svg>
      {label}
      <input type="file" className="sr-only" onChange={onChange} />
    </label>
  );
}

function DropZone({ accept, onFile, children, error, success }) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`relative mt-2 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors ${
        dragging
          ? 'border-[#22eda3] bg-[#22eda3]/10'
          : error
          ? 'border-red-300 bg-red-50'
          : success
          ? 'border-[#22eda3]/60 bg-[#22eda3]/5'
          : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-gray-100/60'
      }`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" className={`mx-auto h-6 w-6 mb-1.5 ${dragging ? 'text-[#22eda3]' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
      </svg>
      <p className={`text-xs font-medium ${dragging ? 'text-[#22eda3]' : success ? 'text-emerald-600' : 'text-gray-500'}`}>
        {success ? success : dragging ? 'Suelta el archivo aquí' : children}
      </p>
      <label className="mt-2 inline-block cursor-pointer text-xs text-[#171433] underline underline-offset-2 hover:text-[#22eda3] transition-colors">
        o selecciona un archivo
        <input type="file" accept={accept} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      </label>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

function StatBox({ label, value, accent }) {
  return (
    <div className={`rounded-xl p-4 ${accent}`}>
      <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">{label}</p>
      <p className="text-lg font-semibold text-[#171433] font-mono">{value}</p>
    </div>
  );
}

function CalcBtn({ loading, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="mt-1 px-6 py-2.5 rounded-lg text-sm font-medium text-white bg-[#171433] hover:bg-[#2a284d] disabled:opacity-40 transition-colors shadow-sm"
    >
      {loading ? 'Calculando…' : label}
    </button>
  );
}

const ANON_MODELS = MODEL_CATALOG.filter((m) =>
  ['gpt-4.1', 'gpt-4.1-mini', 'claude-haiku-4.5'].includes(m.id)
);

function ModelSelector({ label, value, onChange, models = ANON_MODELS }) {
  const selected = getModel(value);
  const openai = models.filter((m) => m.provider === 'OpenAI');
  const anthropic = models.filter((m) => m.provider === 'Anthropic');
  const google = models.filter((m) => m.provider === 'Google');
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {openai.length > 0 && (
          <optgroup label="OpenAI">
            {openai.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — ${m.in} / ${m.out} por 1M tokens
              </option>
            ))}
          </optgroup>
        )}
        {anthropic.length > 0 && (
          <optgroup label="Anthropic">
            {anthropic.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — ${m.in} / ${m.out} por 1M tokens
              </option>
            ))}
          </optgroup>
        )}
        {google.length > 0 && (
          <optgroup label="Google">
            {google.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — ${m.in} / ${m.out} por 1M tokens
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      <p className="mt-1 text-xs text-gray-400">
        Input: <strong>${selected.in}</strong> · Output: <strong>${selected.out}</strong> por 1M tokens
        {selected.where && (
          <>
            {' · '}
            {selected.use === 'env'
              ? <>requiere cambiar <strong>{selected.where}</strong></>
              : <>en uso: {selected.where}</>}
          </>
        )}
      </p>
    </div>
  );
}

// ── Helpers de cálculo de Anonimizador ────────────────────────────────────────
const PRESET_CHARS = { correo: 600, rrss: 250, encuesta: 350 };

function resolveChars(preset, custom, unit) {
  if (preset === 'custom') {
    const v = Number(custom) || 0;
    return unit === 'tokens' ? v * 4 : v;
  }
  return PRESET_CHARS[preset] ?? 600;
}

function calcAnon({ numRecords, avgChars, includeCompanies, modelIn, modelOut }) {
  const extraSystemTokens  = includeCompanies ? 80 : 0;
  const overheadPerCall    = ANON.systemPromptTokens + extraSystemTokens + ANON.userOverheadTokens;
  const recordsPerBatch    = Math.max(1, Math.min(ANON.maxBatchRecords, Math.floor(ANON.maxBatchChars / Math.max(1, avgChars))));
  const numBatches         = Math.ceil(numRecords / recordsPerBatch);
  const inputDataTokens    = numRecords * (avgChars / ANON.inputCharsPerToken);
  const totalInputTokens   = numBatches * overheadPerCall + inputDataTokens;
  const totalOutputTokens  = numRecords * (avgChars / ANON.outputCharsPerToken);
  const usdInput           = (totalInputTokens  / 1e6) * modelIn;
  const usdOutput          = (totalOutputTokens / 1e6) * modelOut;
  const usdTotal           = usdInput + usdOutput;
  return {
    numRecords,
    avgChars: Math.round(avgChars),
    recordsPerBatch,
    numBatches,
    totalInputTokens:  Math.round(totalInputTokens),
    totalOutputTokens: Math.round(totalOutputTokens),
    usdInput,
    usdOutput,
    usdTotal,
    usdPerRecord: usdTotal / Math.max(1, numRecords),
  };
}

export default function Calculadora() {
  const [tab, setTab] = useState('etiquetado');

  /* ── Modelos seleccionados ── */
  const [anonModelId, setAnonModelId] = useState('gpt-4.1-mini');

  /* ── Etiquetado ── */
  const [etqPreset, setEtqPreset] = useState('correo');
  const [etqCustom, setEtqCustom] = useState('');
  const [etqUnit, setEtqUnit] = useState('chars');
  const [etqNumMsg, setEtqNumMsg] = useState(1000);
  const [etqTagging, setEtqTagging] = useState('single');
  const [etqIncludeMerge, setEtqIncludeMerge] = useState(true);
  const [etqMergeRate, setEtqMergeRate] = useState(0.2);
  const [etqCategorias, setEtqCategorias] = useState(DEFAULT_CATEGORIAS);
  const [etqCategoriasFile, setEtqCategoriasFile] = useState('');
  const [etqCategoriasErr, setEtqCategoriasErr] = useState('');
  const [etqResponses, setEtqResponses] = useState('');
  const [etqResponsesFile, setEtqResponsesFile] = useState('');
  const [etqResponsesErr, setEtqResponsesErr] = useState('');
  const [etqLoading, setEtqLoading] = useState(false);
  const [etqResult, setEtqResult] = useState(null);
  const [etqError, setEtqError] = useState('');

  /* ── Levantamiento ── */
  const [levMedium, setLevMedium] = useState('CORREO');
  const [levCompany, setLevCompany] = useState('');
  const [levNum, setLevNum] = useState(1000);
  const [levPreset, setLevPreset] = useState('correo');
  const [levCustom, setLevCustom] = useState('');
  const [levUnit, setLevUnit] = useState('chars');
  const [levNCat, setLevNCat] = useState('0');
  const [levLoading, setLevLoading] = useState(false);
  const [levResult, setLevResult] = useState(null);
  const [levError, setLevError] = useState('');

  /* ── Anonimizador ── */
  const [anonNum, setAnonNum] = useState(1000);
  const [anonPreset, setAnonPreset] = useState('correo');
  const [anonCustom, setAnonCustom] = useState('');
  const [anonUnit, setAnonUnit] = useState('chars');
  const [anonResult, setAnonResult] = useState(null);

  /* ── AutoQA (LLM-as-a-Judge) ── */
  const [qaClaudeId, setQaClaudeId] = useState('claude-sonnet-5');
  const [qaGeminiId, setQaGeminiId] = useState('gemini-3.5-flash');
  const [qaNumMsg, setQaNumMsg] = useState(1000);
  const [qaPreset, setQaPreset] = useState('correo');
  const [qaCustom, setQaCustom] = useState('');
  const [qaUnit, setQaUnit] = useState('chars');
  const [qaDisagree, setQaDisagree] = useState(0.2);
  const [qaCategorias, setQaCategorias] = useState(QA_DEFAULT_CATEGORIAS);
  const [qaCategoriasFile, setQaCategoriasFile] = useState('');
  const [qaCategoriasErr, setQaCategoriasErr] = useState('');
  const [qaLoading, setQaLoading] = useState(false);
  const [qaResult, setQaResult] = useState(null);
  const [qaError, setQaError] = useState('');

  /* ── Corrección (GPT-4.1-mini) ── */
  const [corrNumCat, setCorrNumCat] = useState(25);
  const [corrExamples, setCorrExamples] = useState(8);
  const [corrPreset, setCorrPreset] = useState('rrss');
  const [corrCustom, setCorrCustom] = useState('');
  const [corrUnit, setCorrUnit] = useState('chars');
  const [corrLoading, setCorrLoading] = useState(false);
  const [corrResult, setCorrResult] = useState(null);
  const [corrError, setCorrError] = useState('');

  /* ── Open The Black Box ── */
  const [otbbNumMsg,     setOtbbNumMsg]     = useState(1000);
  const [otbbAnalysisMode, setOtbbAnalysisMode] = useState('first_interaction');
  const [otbbPreset,     setOtbbPreset]     = useState('correo');
  const [otbbCustom,     setOtbbCustom]     = useState('');
  const [otbbUnit,       setOtbbUnit]       = useState('chars');
  const [otbbGptId,      setOtbbGptId]      = useState('gpt-4.1');
  const [otbbLoading,    setOtbbLoading]    = useState(false);
  const [otbbResult,     setOtbbResult]     = useState(null);
  const [otbbError,      setOtbbError]      = useState('');
  const [otbbIncludesWmb, setOtbbIncludesWmb] = useState(false);
  const [otbbWmbNCat,    setOtbbWmbNCat]    = useState(0);  // 0 = auto
  const [otbbTurns,      setOtbbTurns]      = useState(3);

  const runAnonimizador = () => {
    const avgChars = resolveChars(anonPreset, anonCustom, anonUnit);
    const m = getModel(anonModelId);
    setAnonResult(calcAnon({ numRecords: anonNum, avgChars, includeCompanies: false, modelIn: m.in, modelOut: m.out }));
  };

  const runOtbb = async () => {
    setOtbbError(''); setOtbbLoading(true); setOtbbResult(null);
    const gptModel = getModel(otbbGptId);
    // El backend llama a claude-sonnet-5 salvo que CLAUDE_MODEL diga otra cosa
    // (server.js, /proxy/anthropic): la estimación tiene que cotizar ese mismo
    // modelo, no el anterior, o sobreestima la parte de Claude en un 50%.
    const claudeModel = getModel('claude-sonnet-5');
    try {
      const { data } = await axios.post(`${API_BASE}/api/calculator/otbb`, {
        numMessages:            otbbNumMsg,
        analysisMode:           otbbAnalysisMode,
        preset:                 otbbPreset,
        customValue:            otbbCustom === '' ? null : Number(otbbCustom),
        unit:                   otbbUnit,
        inputPriceClaudePer1m:  claudeModel.in,
        outputPriceClaudePer1m: claudeModel.out,
        inputPriceGptPer1m:     gptModel.in,
        outputPriceGptPer1m:    gptModel.out,
        includesWmb:            otbbIncludesWmb,
        wmbNCategories:         otbbWmbNCat,
        avgTurnsPerThread:      otbbTurns,
      });
      setOtbbResult(data);
    } catch (e) {
      setOtbbError(e.response?.data?.error || e.message || 'Error al calcular');
    } finally { setOtbbLoading(false); }
  };

  const readFile = (file) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || ''));
      r.onerror = () => rej(r.error);
      r.readAsText(file, 'utf-8');
    });

  /* ── Acciones ── */
  const runEtiquetado = async () => {
    setEtqError(''); setEtqLoading(true); setEtqResult(null);
    const etqModel = getModel('gpt-4.1');
    try {
      const { data } = await axios.post(`${API_BASE}/api/calculator/etiquetado`, {
        categoriasJson: etqCategorias,
        preset: etqPreset,
        customValue: etqCustom === '' ? null : Number(etqCustom),
        unit: etqUnit,
        totalTokens: etqUnit === 'total_tokens' && etqCustom !== '' ? Number(etqCustom) : null,
        numMessages: etqNumMsg,
        taggingMode: etqTagging,
        responsesText: etqResponses,
        includeMergeSecondCall: etqTagging === 'multitag' ? etqIncludeMerge : false,
        multitagSecondCallRate: etqMergeRate,
        inputPricePer1mUsd: etqModel.in,
        outputPricePer1mUsd: etqModel.out,
      });
      setEtqResult(data);
    } catch (e) {
      setEtqError(e.response?.data?.error || e.message || 'Error al calcular');
    } finally { setEtqLoading(false); }
  };

  const runLevantamiento = async () => {
    setLevError(''); setLevLoading(true); setLevResult(null);
    const levClusterModel = getModel('gpt-4.1');
    const levCatModel = getModel('claude-sonnet-5');
    try {
      const { data } = await axios.post(`${API_BASE}/api/calculator/levantamiento`, {
        medium: levMedium,
        companyType: levCompany || 'empresa',
        numMensajes: levNum,
        preset: levPreset,
        customValue: levCustom === '' ? null : Number(levCustom),
        unit: levUnit,
        totalTokens: levUnit === 'total_tokens' && levCustom !== '' ? Number(levCustom) : null,
        nCategories: levNCat,
        estimatedTopics: null,
        inputPriceGptPer1m: levClusterModel.in,
        outputPriceGptPer1m: levClusterModel.out,
        inputPriceClaudePer1m: levCatModel.in,
        outputPriceClaudePer1m: levCatModel.out,
      });
      setLevResult(data);
    } catch (e) {
      setLevError(e.response?.data?.error || e.message || 'Error al calcular');
    } finally { setLevLoading(false); }
  };

  const runAutoqa = async () => {
    setQaError(''); setQaLoading(true); setQaResult(null);
    const claude = getModel(qaClaudeId);
    const gemini = getModel(qaGeminiId);
    try {
      const { data } = await axios.post(`${API_BASE}/api/calculator/autoqa`, {
        numMessages: qaNumMsg,
        preset: qaPreset,
        customValue: qaCustom === '' ? null : Number(qaCustom),
        unit: qaUnit,
        totalTokens: qaUnit === 'total_tokens' && qaCustom !== '' ? Number(qaCustom) : null,
        categoriasJson: qaCategorias,
        disagreementRate: Number(qaDisagree) || 0,
        inputPriceClaudePer1m: claude.in,
        outputPriceClaudePer1m: claude.out,
        inputPriceGeminiPer1m: gemini.in,
        outputPriceGeminiPer1m: gemini.out,
      });
      setQaResult(data);
    } catch (e) {
      setQaError(e.response?.data?.error || e.message || 'Error al calcular');
    } finally { setQaLoading(false); }
  };

  const runCorreccion = async () => {
    setCorrError(''); setCorrLoading(true); setCorrResult(null);
    const model = getModel('gpt-4.1');
    try {
      const { data } = await axios.post(`${API_BASE}/api/calculator/correccion`, {
        numCategories: corrNumCat,
        examplesPerCategory: corrExamples,
        avgExampleChars: resolveChars(corrPreset, corrCustom, corrUnit),
        inputPricePer1mUsd: model.in,
        outputPricePer1mUsd: model.out,
      });
      setCorrResult(data);
    } catch (e) {
      setCorrError(e.response?.data?.error || e.message || 'Error al calcular');
    } finally { setCorrLoading(false); }
  };

  return (
    <div className="bg-white p-6 rounded-xl shadow-md max-w-4xl mx-auto">

      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[#171433] mb-1">Calculadora de consumo</h2>
        <p className="text-gray-500 text-sm leading-relaxed">
          Herramienta para la estimación de costes en dólares (USD) para clasificación de datos o levantamiento de categorías.
        </p>
      </div>

      {/* Catálogo de modelos */}
      <div className="mb-6 bg-gray-50 border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-[#22eda3]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M4 19h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Catálogo de precios — precios por 1M tokens</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Proveedor</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Modelo</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wide">Input (1M tokens)</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wide">Output (1M tokens)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {MODEL_CATALOG.map((m) => (
                <tr key={m.id} className="hover:bg-white transition-colors">
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      m.provider === 'OpenAI'
                        ? 'bg-green-50 text-green-700'
                        : m.provider === 'Google'
                        ? 'bg-blue-50 text-blue-700'
                        : 'bg-orange-50 text-orange-700'
                    }`}>
                      {m.provider}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-[#171433]">{m.label}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-gray-700">${m.in.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-gray-700">${m.out.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {[
          { id: 'etiquetado', label: 'Etiquetado' },
          { id: 'levantamiento', label: 'Levantamiento' },
          { id: 'autoqa', label: 'AutoQA (Judge)' },
          { id: 'correccion', label: 'Corrección' },
          { id: 'otbb', label: 'Open The Black Box' },
          { id: 'anonimizador', label: 'Anonimizador' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-[#171433] text-[#22eda3] shadow-sm'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ──────────── ETIQUETADO ──────────── */}
      {tab === 'etiquetado' && (
        <div className="space-y-4">

          {/* Mensaje */}
          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Parámetros del mensaje</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel>Tipo de canal</FieldLabel>
                <Select value={etqPreset} onChange={(e) => setEtqPreset(e.target.value)}>
                  <option value="correo">Correo electrónico (~600 caracteres)</option>
                  <option value="rrss">Redes sociales (~250 caracteres)</option>
                  <option value="encuesta">Encuestas (~350 caracteres)</option>
                  <option value="custom">Personalizado</option>
                </Select>
              </div>
              <div>
                <FieldLabel hint="para el coste total de la corrida">Total de mensajes a procesar</FieldLabel>
                <Input
                  type="number" min="1"
                  value={etqNumMsg}
                  onChange={(e) => setEtqNumMsg(Math.max(1, Number(e.target.value)))}
                />
              </div>
              {etqPreset === 'custom' && (
                <>
                  <div>
                    <FieldLabel hint={etqUnit === 'total_tokens' ? 'total del dataset' : 'promedio por mensaje'}>
                      {etqUnit === 'total_tokens' ? 'Total de tokens del dataset' : 'Número de tokens o caracteres'}
                    </FieldLabel>
                    <Input
                      type="number" min="1"
                      value={etqCustom}
                      onChange={(e) => setEtqCustom(e.target.value)}
                      placeholder={etqUnit === 'total_tokens' ? 'ej. 500000' : 'ej. 400'}
                    />
                    <p className="mt-1.5 text-xs text-gray-400">
                      Presets de referencia: correo ~600 chars, RRSS ~250 chars, encuestas ~350 chars.
                    </p>
                  </div>
                  <div>
                    <FieldLabel>Unidad</FieldLabel>
                    <Select value={etqUnit} onChange={(e) => setEtqUnit(e.target.value)}>
                      <option value="chars">Caracteres (por mensaje)</option>
                      <option value="tokens">Tokens (por mensaje, ~×4 caracteres)</option>
                      <option value="total_tokens">Total de tokens (dataset completo)</option>
                    </Select>
                  </div>
                </>
              )}
              <div>
                <FieldLabel>Modo de etiquetado</FieldLabel>
                <Select value={etqTagging} onChange={(e) => setEtqTagging(e.target.value)}>
                  <option value="single">Single tag — una categoría por mensaje</option>
                  <option value="multitag">Multitag — múltiples categorías por mensaje</option>
                </Select>
              </div>
            </div>

            {etqTagging === 'multitag' && (
              <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                <label className="flex items-start gap-2.5 cursor-pointer text-sm text-gray-700">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={etqIncludeMerge}
                    onChange={(e) => setEtqIncludeMerge(e.target.checked)}
                  />
                  <span>
                    Incluir segunda llamada de merge de plantillas
                    <span className="block text-xs text-gray-400 mt-0.5">
                      Pondera el coste de combinar plantillas cuando aplican varias categorías.
                    </span>
                  </span>
                </label>
                {etqIncludeMerge && (
                  <div className="ml-6">
                    <FieldLabel hint="fracción de mensajes que activan el merge">Tasa de segunda llamada</FieldLabel>
                    <Input
                      type="number" step="0.05" min="0" max="1"
                      value={etqMergeRate}
                      onChange={(e) => setEtqMergeRate(Number(e.target.value))}
                      className="max-w-[120px]"
                    />
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Categorías y contexto */}
          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Base de conocimiento</p>
            <div className="space-y-5">
              <div>
                <FieldLabel>Categorías en JSON</FieldLabel>
                <Textarea
                  rows={6}
                  value={etqCategorias}
                  onChange={(e) => { setEtqCategorias(e.target.value); setEtqCategoriasFile(''); }}
                  placeholder='{ "WMA001": "Descripción categoría", ... }'
                />
                <DropZone
                  accept=".json,application/json"
                  error={etqCategoriasErr}
                  success={etqCategoriasFile}
                  onFile={async (f) => {
                    setEtqCategoriasErr('');
                    setEtqCategoriasFile('');
                    try {
                      setEtqCategorias(await readFile(f));
                      setEtqCategoriasFile(`✓ ${f.name}`);
                    } catch {
                      setEtqCategoriasErr('No se pudo leer el archivo');
                    }
                  }}
                >
                  Arrastra aquí tu archivo <strong>.json</strong> de categorías
                </DropZone>
              </div>
              <div>
                <FieldLabel hint="opcional">Respuestas y plantillas</FieldLabel>
                <Textarea
                  rows={4}
                  value={etqResponses}
                  onChange={(e) => { setEtqResponses(e.target.value); setEtqResponsesFile(''); }}
                  placeholder="Pega aquí las plantillas de respuesta o sube un archivo..."
                />
                <DropZone
                  accept=".json,.txt,.md,text/plain"
                  error={etqResponsesErr}
                  success={etqResponsesFile}
                  onFile={async (f) => {
                    setEtqResponsesErr('');
                    setEtqResponsesFile('');
                    try {
                      setEtqResponses(await readFile(f));
                      setEtqResponsesFile(`✓ ${f.name}`);
                    } catch {
                      setEtqResponsesErr('No se pudo leer el archivo');
                    }
                  }}
                >
                  Arrastra aquí tu archivo de <strong>plantillas</strong>
                </DropZone>
              </div>
            </div>
          </Card>

          {/* Tarifa info */}
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#171433]/5 border border-[#171433]/10 text-xs text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-[#22eda3] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Tarifa aplicada: <strong>GPT-4.1</strong> — $2.00 input / $8.00 output por 1M tokens
            </span>
          </div>

          {etqError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{etqError}</p>
          )}

          <CalcBtn loading={etqLoading} label="Calcular coste de la corrida" onClick={runEtiquetado} />

          {etqResult && (
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Coste total" value={fmtUsd(etqResult.usdTotalRun, 4)} accent="bg-[#171433]/5 border border-[#22eda3]/30" />
                <StatBox label="Coste por mensaje" value={fmtUsd(etqResult.usdPerMessage)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Tokens totales" value={fmtNum(etqResult.totalTokens)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Mensajes" value={fmtNum(etqResult.numMessages)} accent="bg-gray-50 border border-gray-200" />
              </div>
              <div className="flex flex-wrap gap-6 text-xs text-gray-500 px-1">
                <span>Tokens input (total): <strong className="text-gray-700">{fmtNum(etqResult.totalTokensIn)}</strong></span>
                <span>Tokens output (total): <strong className="text-gray-700">{fmtNum(etqResult.totalTokensOut)}</strong></span>
                <span>Chars/mensaje: <strong className="text-gray-700">{fmtNum(etqResult.avgCharsResolved)}</strong></span>
              </div>
              <details className="group">
                <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none">
                  Ver desglose completo ▾
                </summary>
                <pre className="mt-2 p-4 bg-gray-900 text-green-200 rounded-lg text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(etqResult, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ──────────── OPEN THE BLACK BOX ──────────── */}
      {tab === 'otbb' && (
        <div className="space-y-4">

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Parámetros del proceso</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel>Modo a calcular</FieldLabel>
                <Select value={otbbAnalysisMode} onChange={(e) => setOtbbAnalysisMode(e.target.value)}>
                  <option value="first_interaction">Hilo suelto</option>
                  <option value="thread">Conversación</option>
                </Select>
              </div>
              <div>
                <FieldLabel hint={otbbAnalysisMode === 'thread' ? 'unidad que se envía al modelo' : 'mensajes a clasificar'}>
                  {otbbAnalysisMode === 'thread' ? 'N° de conversaciones' : 'N° de mensajes'}
                </FieldLabel>
                <Input
                  type="number" min="1"
                  value={otbbNumMsg}
                  onChange={(e) => setOtbbNumMsg(Math.max(1, Number(e.target.value)))}
                />
              </div>
              {otbbAnalysisMode === 'thread' && (
                <div>
                  <FieldLabel hint="define el tamaño de la salida: una etiqueta por turno">Turnos por conversación</FieldLabel>
                  <Input
                    type="number" min="1"
                    value={otbbTurns}
                    onChange={(e) => setOtbbTurns(Math.max(1, Number(e.target.value)))}
                  />
                </div>
              )}
              <div>
                <FieldLabel>Tipo de canal</FieldLabel>
                <Select value={otbbPreset} onChange={(e) => setOtbbPreset(e.target.value)}>
                  <option value="correo">
                    {otbbAnalysisMode === 'thread'
                      ? 'Correo electrónico (~900 caracteres por conversación)'
                      : 'Correo electrónico (~600 caracteres)'}
                  </option>
                  <option value="rrss">Redes sociales (~250 caracteres)</option>
                  <option value="encuesta">Encuestas (~350 caracteres)</option>
                  <option value="custom">Personalizado</option>
                </Select>
              </div>
              {otbbPreset === 'custom' && (
                <>
                  <div>
                    <FieldLabel hint={otbbAnalysisMode === 'thread' ? 'promedio del transcript completo' : 'promedio por mensaje'}>
                      Número de tokens o caracteres
                    </FieldLabel>
                    <Input
                      type="number" min="1"
                      value={otbbCustom}
                      onChange={(e) => setOtbbCustom(e.target.value)}
                      placeholder="ej. 400"
                    />
                  </div>
                  <div>
                    <FieldLabel>Unidad</FieldLabel>
                    <Select value={otbbUnit} onChange={(e) => setOtbbUnit(e.target.value)}>
                      <option value="chars">Caracteres</option>
                      <option value="tokens">Tokens (~×4 caracteres)</option>
                    </Select>
                  </div>
                </>
              )}
              <div>
                <FieldLabel hint="para la fase de etiquetado">Modelo de etiquetado</FieldLabel>
                <Select value={otbbGptId} onChange={(e) => setOtbbGptId(e.target.value)}>
                  <option value="gpt-4.1">GPT-4.1 (rápido, menor costo)</option>
                  <option value="gpt-5.2">GPT-5.2 (mayor precisión)</option>
                  <option value="gpt-5.6-luna">GPT-5.6-luna (menos preciso, más barato)</option>
                  <option value="claude-sonnet-5">Claude Sonnet 5 (experimental, más costoso)</option>
                </Select>
              </div>
            </div>

            {/* Toggle WMB */}
            <div className={`mt-4 rounded-xl border p-4 transition-colors ${otbbIncludesWmb ? 'border-violet-200 bg-violet-50/50' : 'border-gray-100 bg-gray-50/50'}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-700">Incluye recomendación IA</p>
                  <p className="text-xs text-gray-400 mt-0.5">Levanta categorías emergentes desde los mensajes clasificados como "Otros"</p>
                </div>
                <button
                  onClick={() => setOtbbIncludesWmb(v => !v)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${otbbIncludesWmb ? 'bg-violet-500' : 'bg-gray-300'} cursor-pointer`}>
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${otbbIncludesWmb ? 'translate-x-4' : 'translate-x-1'}`} />
                </button>
              </div>
              {otbbIncludesWmb && (
                <div className="mt-3">
                  <FieldLabel hint="categorías emergentes a generar">Cantidad de categorías</FieldLabel>
                  <Select value={otbbWmbNCat} onChange={e => setOtbbWmbNCat(Number(e.target.value))}>
                    <option value={0}>Dejar que el modelo decida (~10)</option>
                    <option value={8}>Pocas — 8 categorías</option>
                    <option value={15}>Suficientes — 15 categorías</option>
                    <option value={25}>Bastantes — 25 categorías</option>
                  </Select>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Lógica de cálculo</p>
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p>• <strong>Fase GPT-4.1</strong> — extrae temáticas desde la muestra, siguiendo la lógica de levantamiento.</p>
              <p>• <strong>Fase Claude</strong> — mapea esas temáticas contra los 80 WMA existentes de Catalogo_Banca y construye el maestro aplicable.</p>
              <p>• <strong>Fase GPT (batches × 10)</strong> — etiqueta todos los mensajes contra el maestro aplicable (~40 WMA) e incluye confianza, evidencia y justificación.</p>
              <p>• <strong>Modo conversacional</strong> — usa un promedio de correo más alto (~900 caracteres) para reflejar transcripts de conversación.</p>
            </div>
          </Card>

          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#171433]/5 border border-[#171433]/10 text-xs text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-[#22eda3] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Tarifas: <strong>GPT-4.1 levantamiento</strong> $2.00/$8.00 · <strong>Claude Sonnet 4.6</strong> $3.00/$15.00 · <strong>{getModel(otbbGptId).label}</strong> ${getModel(otbbGptId).in.toFixed(2)}/${getModel(otbbGptId).out.toFixed(2)} por 1M tokens
            </span>
          </div>

          {otbbError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{otbbError}</p>
          )}

          <CalcBtn loading={otbbLoading} label="Calcular coste del análisis" onClick={runOtbb} />

          {otbbResult && (
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Coste total" value={fmtUsd(otbbResult.usdTotal, 4)} accent="bg-[#171433]/5 border border-[#22eda3]/30" />
                <StatBox label="GPT levantamiento" value={fmtUsd(otbbResult.usdClustering, 4)} accent="bg-blue-50 border border-blue-200" />
                <StatBox label="Claude mapping" value={fmtUsd(otbbResult.usdClaude, 4)} accent="bg-orange-50 border border-orange-200" />
                <StatBox label="GPT etiquetado" value={fmtUsd(otbbResult.usdGpt, 4)} accent="bg-green-50 border border-green-200" />
                <StatBox label="Tokens totales" value={fmtNum(otbbResult.totalTokens)} accent="bg-gray-50 border border-gray-200" />
                {otbbResult.includesWmb && (
                  <>
                    <StatBox label="WMB total" value={fmtUsd(otbbResult.usdWmb, 4)} accent="bg-violet-50 border border-violet-200" />
                    <StatBox label="WMB clustering" value={fmtUsd(otbbResult.usdWmbClustering, 4)} accent="bg-violet-50 border border-violet-100" />
                    <StatBox label="WMB Claude" value={fmtUsd(otbbResult.usdWmbClaude, 4)} accent="bg-violet-50 border border-violet-100" />
                    <StatBox label="WMB etiquetado" value={fmtUsd(otbbResult.usdWmbGpt, 4)} accent="bg-violet-50 border border-violet-100" />
                  </>
                )}
              </div>
              <div className="flex flex-wrap gap-6 text-xs text-gray-500 px-1">
                <span>{otbbResult.analysisMode === 'thread' ? 'Conversaciones' : 'Mensajes'}: <strong className="text-gray-700">{fmtNum(otbbResult.numMessages)}</strong></span>
                <span>Modo: <strong className="text-gray-700">{otbbResult.analysisMode === 'thread' ? 'Conversación' : 'Hilo suelto'}</strong></span>
                <span>Chars/{otbbResult.analysisMode === 'thread' ? 'conversación' : 'msg'}: <strong className="text-gray-700">{fmtNum(otbbResult.avgCharsPerMessage)}</strong></span>
                {otbbResult.analysisMode === 'thread' && (
                  <>
                    <span>Turnos/conversación: <strong className="text-gray-700">{fmtNum(otbbResult.avgTurnsPerThread)}</strong></span>
                    <span>Taxonomía en prompt: <strong className="text-gray-700">{fmtNum(otbbResult.taxonomyPromptTokens)}</strong> tok/batch</span>
                  </>
                )}
                <span>Catálogo en Claude: <strong className="text-gray-700">{fmtNum(otbbResult.claudeCatalogTokens)}</strong> tok</span>
                <span>System prompt etiquetado: <strong className="text-gray-700">{fmtNum(otbbResult.gptSysTokens)}</strong> tok/batch</span>
                <span>Batches levantamiento: <strong className="text-gray-700">{fmtNum(otbbResult.numBatchesClustering)}</strong></span>
                <span>Temáticas estimadas: <strong className="text-gray-700">{fmtNum(otbbResult.estimatedClusters)}</strong></span>
                <span>Batches GPT: <strong className="text-gray-700">{fmtNum(otbbResult.numBatchesGpt)}</strong> (de {fmtNum(otbbResult.batchTagging)})</span>
                <span>Salida/ítem: <strong className="text-gray-700">{fmtNum(otbbResult.gptOutPerItem)}</strong> tok</span>
                {otbbResult.includesWmb && (
                  <>
                    <span>Msgs "Otros": <strong className="text-violet-700">{fmtNum(otbbResult.nWmbMsg)}</strong></span>
                    <span>Cats emergentes: <strong className="text-violet-700">{fmtNum(otbbResult.wmbCategories)}</strong></span>
                  </>
                )}
              </div>
              <details className="group">
                <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none">
                  Ver desglose completo ▾
                </summary>
                <pre className="mt-2 p-4 bg-gray-900 text-indigo-200 rounded-lg text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(otbbResult, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ──────────── ANONIMIZADOR ──────────── */}
      {tab === 'anonimizador' && (
        <div className="space-y-4">

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Parámetros del proceso</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ModelSelector label="Modelo de anonimización" value={anonModelId} onChange={setAnonModelId} />
              <div>
                <FieldLabel>Total de registros a anonimizar</FieldLabel>
                <Input
                  type="number" min="1"
                  value={anonNum}
                  onChange={(e) => setAnonNum(Math.max(1, Number(e.target.value)))}
                />
              </div>
              <div>
                <FieldLabel>Tipo de canal</FieldLabel>
                <Select value={anonPreset} onChange={(e) => setAnonPreset(e.target.value)}>
                  <option value="correo">Correo electrónico (~600 caracteres)</option>
                  <option value="rrss">Redes sociales (~250 caracteres)</option>
                  <option value="encuesta">Encuestas (~350 caracteres)</option>
                  <option value="custom">Personalizado</option>
                </Select>
              </div>
              {anonPreset === 'custom' && (
                <>
                  <div>
                    <FieldLabel hint="promedio por registro">Número de tokens o caracteres</FieldLabel>
                    <Input
                      type="number" min="1"
                      value={anonCustom}
                      onChange={(e) => setAnonCustom(e.target.value)}
                      placeholder="ej. 400"
                    />
                    <p className="mt-1.5 text-xs text-gray-400">
                      Presets de referencia: correo ~600 chars, RRSS ~250 chars, encuestas ~350 chars.
                    </p>
                  </div>
                  <div>
                    <FieldLabel>Unidad</FieldLabel>
                    <Select value={anonUnit} onChange={(e) => setAnonUnit(e.target.value)}>
                      <option value="chars">Caracteres</option>
                      <option value="tokens">Tokens (~×4 caracteres)</option>
                    </Select>
                  </div>
                </>
              )}
            </div>

          </Card>

          {/* Cómo se calcula */}
          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Lógica de cálculo</p>
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p>• Cada llamada agrupa hasta <strong>20 registros</strong> o <strong>40 000 chars</strong> (el límite que se alcance primero).</p>
              <p>• <strong>Input por llamada</strong> = overhead fijo (~880 tokens: system prompt + instrucción de batch) + datos del lote (chars ÷ 4).</p>
              <p>• <strong>Output por llamada</strong> = texto anonimizado + estructura JSON ≈ chars de entrada ÷ 3.5.</p>
              <p>• Los reintentos por error no se contemplan (happy path).</p>
            </div>
          </Card>

          {/* Tarifa info */}
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#171433]/5 border border-[#171433]/10 text-xs text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-[#22eda3] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Tarifa aplicada: <strong>{getModel(anonModelId).label}</strong> —{' '}
              ${getModel(anonModelId).in.toFixed(2)} input / ${getModel(anonModelId).out.toFixed(2)} output por 1M tokens
            </span>
          </div>

          <CalcBtn loading={false} label="Calcular coste de anonimización" onClick={runAnonimizador} />

          {anonResult && (
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Coste total"      value={fmtUsd(anonResult.usdTotal, 4)}     accent="bg-[#171433]/5 border border-[#22eda3]/30" />
                <StatBox label="Coste / registro" value={fmtUsd(anonResult.usdPerRecord, 6)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Tokens input"     value={fmtNum(anonResult.totalInputTokens)}  accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Tokens output"    value={fmtNum(anonResult.totalOutputTokens)} accent="bg-gray-50 border border-gray-200" />
              </div>
              <div className="flex flex-wrap gap-6 text-xs text-gray-500 px-1">
                <span>Llamadas LLM: <strong className="text-gray-700">{fmtNum(anonResult.numBatches)}</strong></span>
                <span>Registros por lote: <strong className="text-gray-700">{anonResult.recordsPerBatch}</strong></span>
                <span>Chars promedio/registro: <strong className="text-gray-700">{fmtNum(anonResult.avgChars)}</strong></span>
                <span>Coste input: <strong className="text-gray-700">{fmtUsd(anonResult.usdInput, 4)}</strong></span>
                <span>Coste output: <strong className="text-gray-700">{fmtUsd(anonResult.usdOutput, 4)}</strong></span>
              </div>
              <details className="group">
                <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none">
                  Ver desglose completo ▾
                </summary>
                <pre className="mt-2 p-4 bg-gray-900 text-purple-200 rounded-lg text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(anonResult, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ──────────── LEVANTAMIENTO ──────────── */}
      {tab === 'levantamiento' && (
        <div className="space-y-4">

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Parámetros de la corrida</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel>Tipo de canal</FieldLabel>
                <Select value={levMedium} onChange={(e) => setLevMedium(e.target.value)}>
                  <option value="CORREO">Correo electrónico</option>
                  <option value="RRSS">Redes sociales</option>
                  <option value="ENCUESTA">Encuestas</option>
                </Select>
              </div>
              <div>
                <FieldLabel hint="opcional">Tipo de industria</FieldLabel>
                <Input
                  value={levCompany}
                  onChange={(e) => setLevCompany(e.target.value)}
                  placeholder="ej. banca, retail, salud..."
                />
              </div>
              <div>
                <FieldLabel>Total de mensajes a procesar</FieldLabel>
                <Input
                  type="number" min="1"
                  value={levNum}
                  onChange={(e) => setLevNum(Number(e.target.value))}
                />
              </div>
              <div>
                <FieldLabel>Categorías de salida</FieldLabel>
                <Select value={levNCat} onChange={(e) => setLevNCat(e.target.value)}>
                  <option value="5">Muy pocas (~5 categorías)</option>
                  <option value="8">Pocas (~8 categorías)</option>
                  <option value="0">El modelo decide (mín. 10)</option>
                  <option value="25">Muchas (~25 categorías)</option>
                </Select>
              </div>
              <div>
                <FieldLabel>Largo de mensaje</FieldLabel>
                <Select value={levPreset} onChange={(e) => setLevPreset(e.target.value)}>
                  <option value="correo">Correo (~600 chars)</option>
                  <option value="rrss">RRSS (~250 chars)</option>
                  <option value="encuesta">Encuestas (~350 chars)</option>
                  <option value="custom">Personalizado</option>
                </Select>
              </div>
              {levPreset === 'custom' && (
                <>
                  <div>
                    <FieldLabel hint={levUnit === 'total_tokens' ? 'total del dataset' : 'promedio por mensaje'}>
                      {levUnit === 'total_tokens' ? 'Total de tokens del dataset' : 'Número de tokens o caracteres'}
                    </FieldLabel>
                    <Input
                      type="number" min="1"
                      value={levCustom}
                      onChange={(e) => setLevCustom(e.target.value)}
                      placeholder={levUnit === 'total_tokens' ? 'ej. 500000' : 'ej. 400'}
                    />
                    <p className="mt-1.5 text-xs text-gray-400">
                      {levUnit === 'total_tokens'
                        ? 'El total se reparte entre el número de mensajes a procesar.'
                        : 'Presets de referencia: correo ~600 chars, RRSS ~250 chars, encuestas ~350 chars.'}
                    </p>
                  </div>
                  <div>
                    <FieldLabel>Unidad</FieldLabel>
                    <Select value={levUnit} onChange={(e) => setLevUnit(e.target.value)}>
                      <option value="chars">Caracteres (por mensaje)</option>
                      <option value="tokens">Tokens (por mensaje, ~×4 caracteres)</option>
                      <option value="total_tokens">Total de tokens (dataset completo)</option>
                    </Select>
                  </div>
                </>
              )}
            </div>
          </Card>

          {/* Tarifa info */}
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#171433]/5 border border-[#171433]/10 text-xs text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-[#22eda3] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Clustering: <strong>GPT-4.1</strong> $2.00 / $8.00 ·{' '}
              Categorías: <strong>Claude Sonnet 4.6</strong> $3.00 / $15.00 — por 1M tokens
            </span>
          </div>

          {levError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{levError}</p>
          )}

          <CalcBtn loading={levLoading} label="Calcular coste de la corrida" onClick={runLevantamiento} />

          {levResult && (
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Coste total" value={fmtUsd(levResult.usdTotalRun, 4)} accent="bg-[#171433]/5 border border-[#22eda3]/30" />
                <StatBox label="Clustering (GPT)" value={fmtUsd(levResult.usdClustering, 4)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Categorías (Claude)" value={fmtUsd(levResult.usdClaude, 4)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Formato JSON (GPT)" value={fmtUsd(levResult.usdFormat, 4)} accent="bg-gray-50 border border-gray-200" />
              </div>
              <div className="flex flex-wrap gap-6 text-xs text-gray-500 px-1">
                <span>Tokens totales: <strong className="text-gray-700">{fmtNum(levResult.totalTokens)}</strong></span>
                <span>Lotes de clustering: <strong className="text-gray-700">{levResult.numBatchesClustering}</strong></span>
                <span>Temáticas estimadas: <strong className="text-gray-700">{levResult.estimatedTopicsUsed}</strong></span>
                <span>Mensajes: <strong className="text-gray-700">{fmtNum(levResult.numMensajes)}</strong></span>
              </div>
              <details className="group">
                <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none">
                  Ver desglose completo ▾
                </summary>
                <pre className="mt-2 p-4 bg-gray-900 text-cyan-200 rounded-lg text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(levResult, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ──────────── AUTOQA (LLM-AS-A-JUDGE) ──────────── */}
      {tab === 'autoqa' && (
        <div className="space-y-4">

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Parámetros del LLM-as-a-Judge</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ModelSelector
                label="Juez 1 (siempre)"
                value={qaClaudeId}
                onChange={setQaClaudeId}
                models={MODEL_CATALOG.filter((m) => m.provider === 'Anthropic')}
              />
              <ModelSelector
                label="Juez 2 (solo en desacuerdo)"
                value={qaGeminiId}
                onChange={setQaGeminiId}
                models={MODEL_CATALOG.filter((m) => m.provider === 'Google' || m.provider === 'OpenAI')}
              />
              <div>
                <FieldLabel>Total de mensajes a evaluar</FieldLabel>
                <Input
                  type="number" min="1"
                  value={qaNumMsg}
                  onChange={(e) => setQaNumMsg(Math.max(1, Number(e.target.value)))}
                />
              </div>
              <div>
                <FieldLabel hint="fracción que activa al juez 2">Tasa de desacuerdo</FieldLabel>
                <Input
                  type="number" step="0.05" min="0" max="1"
                  value={qaDisagree}
                  onChange={(e) => setQaDisagree(Number(e.target.value))}
                />
              </div>
              <div>
                <FieldLabel>Tipo de canal</FieldLabel>
                <Select value={qaPreset} onChange={(e) => setQaPreset(e.target.value)}>
                  <option value="correo">Correo electrónico (~600 caracteres)</option>
                  <option value="rrss">Redes sociales (~250 caracteres)</option>
                  <option value="encuesta">Encuestas (~350 caracteres)</option>
                  <option value="custom">Personalizado</option>
                </Select>
              </div>
              {qaPreset === 'custom' && (
                <>
                  <div>
                    <FieldLabel hint={qaUnit === 'total_tokens' ? 'total del dataset' : 'promedio por mensaje'}>
                      {qaUnit === 'total_tokens' ? 'Total de tokens del dataset' : 'Número de tokens o caracteres'}
                    </FieldLabel>
                    <Input
                      type="number" min="1"
                      value={qaCustom}
                      onChange={(e) => setQaCustom(e.target.value)}
                      placeholder={qaUnit === 'total_tokens' ? 'ej. 500000' : 'ej. 400'}
                    />
                  </div>
                  <div>
                    <FieldLabel>Unidad</FieldLabel>
                    <Select value={qaUnit} onChange={(e) => setQaUnit(e.target.value)}>
                      <option value="chars">Caracteres (por mensaje)</option>
                      <option value="tokens">Tokens (por mensaje, ~×4 caracteres)</option>
                      <option value="total_tokens">Total de tokens (dataset completo)</option>
                    </Select>
                  </div>
                </>
              )}
            </div>
          </Card>

          {/* Maestro de categorías: define el largo de la definición que recibe el juez */}
          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Maestro de categorías</p>
            <div>
              <FieldLabel hint="el juez recibe la definición de la categoría asignada">Categorías en JSON</FieldLabel>
              <Textarea
                rows={6}
                value={qaCategorias}
                onChange={(e) => { setQaCategorias(e.target.value); setQaCategoriasFile(''); }}
                placeholder='{ "WMA001": "Nombre [Definición de la categoría]", ... }'
              />
              <DropZone
                accept=".json,application/json"
                error={qaCategoriasErr}
                success={qaCategoriasFile}
                onFile={async (f) => {
                  setQaCategoriasErr('');
                  setQaCategoriasFile('');
                  try {
                    setQaCategorias(await readFile(f));
                    setQaCategoriasFile(`✓ ${f.name}`);
                  } catch {
                    setQaCategoriasErr('No se pudo leer el archivo');
                  }
                }}
              >
                Arrastra aquí tu archivo <strong>.json</strong> de categorías
              </DropZone>
              <p className="mt-1.5 text-xs text-gray-400">
                El largo de la definición se estima como el promedio de las definiciones del maestro (igual que en Etiquetado).
              </p>
            </div>
          </Card>

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Lógica de cálculo</p>
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p>• El <strong>juez 1</strong> (Claude) evalúa <strong>todos</strong> los mensajes.</p>
              <p>• El <strong>juez 2</strong> (Gemini 3.5 Flash) solo se invoca cuando el juez 1 está en desacuerdo, según la tasa de desacuerdo.</p>
              <p>• Cada llamada usa el mismo <code>judgePrompt</code> de <code>/proxy/judge</code> (mensaje + categoría + definición + justificación) y devuelve un JSON corto.</p>
            </div>
          </Card>

          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#171433]/5 border border-[#171433]/10 text-xs text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-[#22eda3] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Juez 1: <strong>{getModel(qaClaudeId).label}</strong> ${getModel(qaClaudeId).in} / ${getModel(qaClaudeId).out} ·{' '}
              Juez 2: <strong>{getModel(qaGeminiId).label}</strong> ${getModel(qaGeminiId).in} / ${getModel(qaGeminiId).out} — por 1M tokens
            </span>
          </div>

          {qaError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{qaError}</p>
          )}

          <CalcBtn loading={qaLoading} label="Calcular coste del AutoQA" onClick={runAutoqa} />

          {qaResult && (
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Coste total" value={fmtUsd(qaResult.usdTotal, 4)} accent="bg-[#171433]/5 border border-[#22eda3]/30" />
                <StatBox label="Juez 1 (Claude)" value={fmtUsd(qaResult.usdClaude, 4)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Juez 2 (Gemini)" value={fmtUsd(qaResult.usdGemini, 4)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Tokens totales" value={fmtNum(qaResult.totalTokens)} accent="bg-gray-50 border border-gray-200" />
              </div>
              <div className="flex flex-wrap gap-6 text-xs text-gray-500 px-1">
                <span>Llamadas juez 1: <strong className="text-gray-700">{fmtNum(qaResult.claudeCalls)}</strong></span>
                <span>Llamadas juez 2: <strong className="text-gray-700">{fmtNum(qaResult.geminiCalls)}</strong></span>
                <span>Chars/mensaje: <strong className="text-gray-700">{fmtNum(qaResult.avgCharsPerMessage)}</strong></span>
                <span>Chars/definición ({qaResult.defSource}): <strong className="text-gray-700">{fmtNum(qaResult.avgDefChars)}</strong></span>
              </div>
              <details className="group">
                <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none">
                  Ver desglose completo ▾
                </summary>
                <pre className="mt-2 p-4 bg-gray-900 text-amber-200 rounded-lg text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(qaResult, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ──────────── CORRECCIÓN ──────────── */}
      {tab === 'correccion' && (
        <div className="space-y-4">

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-4">Parámetros de la corrección</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel hint="categorías marcadas 'No' por el juez">N° de categorías a revisar</FieldLabel>
                <Input
                  type="number" min="1"
                  value={corrNumCat}
                  onChange={(e) => setCorrNumCat(Math.max(1, Number(e.target.value)))}
                />
              </div>
              <div>
                <FieldLabel hint="mensajes mal clasificados de muestra">Ejemplos por categoría</FieldLabel>
                <Input
                  type="number" min="0"
                  value={corrExamples}
                  onChange={(e) => setCorrExamples(Math.max(0, Number(e.target.value)))}
                />
              </div>
              <div>
                <FieldLabel hint="largo medio del ejemplo">Tipo de canal</FieldLabel>
                <Select value={corrPreset} onChange={(e) => setCorrPreset(e.target.value)}>
                  <option value="correo">Correo electrónico (~600 caracteres)</option>
                  <option value="rrss">Redes sociales (~250 caracteres)</option>
                  <option value="encuesta">Encuestas (~350 caracteres)</option>
                  <option value="custom">Personalizado</option>
                </Select>
              </div>
              {corrPreset === 'custom' && (
                <>
                  <div>
                    <FieldLabel hint="por ejemplo">Número de tokens o caracteres</FieldLabel>
                    <Input
                      type="number" min="1"
                      value={corrCustom}
                      onChange={(e) => setCorrCustom(e.target.value)}
                      placeholder="ej. 400"
                    />
                  </div>
                  <div>
                    <FieldLabel>Unidad</FieldLabel>
                    <Select value={corrUnit} onChange={(e) => setCorrUnit(e.target.value)}>
                      <option value="chars">Caracteres</option>
                      <option value="tokens">Tokens (~×4 caracteres)</option>
                    </Select>
                  </div>
                </>
              )}
            </div>
          </Card>

          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Lógica de cálculo</p>
            <div className="text-xs text-gray-500 leading-relaxed space-y-1">
              <p>• Una llamada a <strong>GPT-4.1</strong> por cada categoría a revisar (endpoint <code>/proxy/correct</code>).</p>
              <p>• El input incluye la definición actual + los ejemplos mal clasificados; la salida se acota a ~1600 tokens.</p>
              <p>• Cada llamada decide entre redefinir la categoría o proponer una nueva.</p>
            </div>
          </Card>

          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#171433]/5 border border-[#171433]/10 text-xs text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-[#22eda3] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>
              Tarifa aplicada: <strong>GPT-4.1</strong> — $2.00 input / $8.00 output por 1M tokens
            </span>
          </div>

          {corrError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{corrError}</p>
          )}

          <CalcBtn loading={corrLoading} label="Calcular coste de la corrección" onClick={runCorreccion} />

          {corrResult && (
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Coste total" value={fmtUsd(corrResult.usdTotal, 4)} accent="bg-[#171433]/5 border border-[#22eda3]/30" />
                <StatBox label="Tokens totales" value={fmtNum(corrResult.totalTokens)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Tokens input" value={fmtNum(corrResult.tokensIn)} accent="bg-gray-50 border border-gray-200" />
                <StatBox label="Tokens output" value={fmtNum(corrResult.tokensOut)} accent="bg-gray-50 border border-gray-200" />
              </div>
              <div className="flex flex-wrap gap-6 text-xs text-gray-500 px-1">
                <span>Llamadas LLM: <strong className="text-gray-700">{fmtNum(corrResult.numCategories)}</strong></span>
                <span>Ejemplos/categoría: <strong className="text-gray-700">{fmtNum(corrResult.examplesPerCategory)}</strong></span>
              </div>
              <details className="group">
                <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none">
                  Ver desglose completo ▾
                </summary>
                <pre className="mt-2 p-4 bg-gray-900 text-orange-200 rounded-lg text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(corrResult, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
