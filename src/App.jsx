import { Component, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { Invento } from './invento';
import { Etiquetado, BATCH_SIZE as ETQ_BATCH_SIZE } from './etiquetado';
import AutoQA from './AutoQA';
import Calculadora from './Calculadora';
import ResultsView from './ResultsView';
import EtiquetadoResultsView from './EtiquetadoResultsView';
import CategoriasEditor, { parseCategoriasMaster, stringifyCategoriasMaster } from './CategoriasEditor';
import OpenBlackBox from './OpenBlackBox';
import AppShell from './AppShell';
import FileDropzone from './ui/FileDropzone';
import FilePreflight from './ui/FilePreflight';
import { MAX_DATOS_MB, MAX_JSON_MB, estimarLlamadas } from './ui/archivos';
import { API_BASE } from './config';

// ── Sistema de diseño compartido ──────────────────────────────────────────────
const UI = {
  card:  'bg-surface rounded-panel border border-line shadow-panel',
  label: 'block text-sm font-medium text-ink mb-1.5',
  input: 'block w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:outline-none focus:border-navy/30 focus:ring-2 focus:ring-accent/20 transition-colors',
  hint:  'mt-1.5 text-xs text-ink-muted',
};

class OtbbErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('OTBB render crashed', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-panel border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          Error al abrir OTBB: {String(this.state.error.message || this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  // Estados para Levantamiento
  const [file, setFile] = useState(null);
  const [columns, setColumns] = useState([]);
  const [selectedColumn, setSelectedColumn] = useState('');
  const [medium, setMedium] = useState('CORREO');
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  const [companyTypeInput, setCompanyTypeInput] = useState('banca');
  const [levVertical, setLevVertical] = useState('');
  const [levCatalogRef, setLevCatalogRef] = useState(null);
  const [levCatalogLoading, setLevCatalogLoading] = useState(false);
  const [levPhase, setLevPhase] = useState({ step: 0, total: 3, label: '' });
  const [selectedCategoryCount, setSelectedCategoryCount] = useState("0");
  // Conteo de filas leído al cargar: sin esto no había forma de saber
  // cuántos registros se iban a procesar hasta que el análisis terminaba.
  const [levRowCount, setLevRowCount] = useState(null);
  const [levParsing, setLevParsing] = useState(false);

  // Estados para Etiquetado
  const [etiquetadoFile, setEtiquetadoFile] = useState(null);
  const [categoriasFile, setCategoriasFile] = useState(null);
  const [categoriasSaved, setCategoriasSaved] = useState(null);
  const [categoriasDraft, setCategoriasDraft] = useState('');
  const [categoriasEditorOpen, setCategoriasEditorOpen] = useState(false);
  const [categoriasEditorError, setCategoriasEditorError] = useState('');
  const [etiquetaColumns, setEtiquetaColumns] = useState([]);
  const [selectedEtiquetaColumn, setSelectedEtiquetaColumn] = useState('');
  const [etiquetadoStarted, setEtiquetadoStarted] = useState(false);
  const [etiquetadoProgress, setEtiquetadoProgress] = useState(0);
  const [etiquetadoError, setEtiquetadoError] = useState('');
  const [taggingMode, setTaggingMode] = useState('single');
  const [etiquetadoModelMode, setEtiquetadoModelMode] = useState('prod');
  const [ignoreInput, setIgnoreInput] = useState('');
  const [deriveInput, setDeriveInput] = useState('');
  const [etqRowCount, setEtqRowCount] = useState(null);
  const [etqParsing, setEtqParsing] = useState(false);
  // ── Resultados con persistencia en localStorage ──────────────────────────────
  const readCache = (key) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
  };
  const writeCache = (key, value) => {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* cuota excedida */ }
  };

  const [etiquetadoResultProd, _setEtiquetadoResultProd] = useState(() => readCache('wird_etq_prod'));
  const setEtiquetadoResultProd = (v) => { writeCache('wird_etq_prod', v); _setEtiquetadoResultProd(v); };

  const [etiquetadoResultGpt, _setEtiquetadoResultGpt] = useState(() => readCache('wird_etq_gpt'));
  const setEtiquetadoResultGpt = (v) => { writeCache('wird_etq_gpt', v); _setEtiquetadoResultGpt(v); };

  const [levantamientoResult, _setLevantamientoResult] = useState(() => readCache('wird_lev_result'));
  const setLevantamientoResult = (v) => { writeCache('wird_lev_result', v); _setLevantamientoResult(v); };

  // Refs de cancelación
  const levCancelledRef = useRef(false);
  const etqCancelledRef = useRef(false);

  // Claves para forzar remount de inputs de archivo al hacer reset
  const [levFileKey, setLevFileKey] = useState(0);
  const [etqFileKey, setEtqFileKey] = useState(0);
  const [autoQAKey, setAutoQAKey] = useState(0);

  // Catálogo experto (Banca/Retail/Seguros/Telefonía) cargado desde el backend.
  // Se usa tanto en Levantamiento (agrupación general) como en Etiquetado (sugerencias para "Otros").
  const [expertVerticals, setExpertVerticals] = useState({});
  const [etiquetadoExpertVertical, setEtiquetadoExpertVertical] = useState('');

  useEffect(() => {
    let cancelled = false;
    axios.get(`${API_BASE}/api/catalog/verticals`).then(resp => {
      if (!cancelled && resp.data && typeof resp.data === 'object') setExpertVerticals(resp.data);
    }).catch(err => console.warn('No se pudo cargar el catálogo experto:', err.message));
    return () => { cancelled = true; };
  }, []);

  const expertVerticalOptions = Object.keys(expertVerticals);

  // Estado global de pestaña activa
  const [currentView, setCurrentView] = useState('levantamiento');

  // Opciones para cantidad de categorías
  const categoryOptions = [
    { label: "Muy pocas (~5 categorías, ~15-20 códigos WMA)", value: "5" },
    { label: "Pocas (~8 categorías, ~24-32 códigos WMA)", value: "8" },
    { label: "Dejar que el modelo decida", value: "0" },
    { label: "Muchas (~25 categorías, ~75-100 códigos WMA)", value: "25" }
  ];

  // Opciones para modo de etiquetado
  const taggingModeOptions = [
    { label: "SingleTag", value: "single" },
    { label: "MultiTag", value: "multi" }
  ];

  // Maneja carga del archivo para levantamiento.
  //
  // El formato y el tamaño los valida `FileDropzone` antes de llegar aquí.
  // La versión anterior leía las cabeceras con un `FileReader` cuyo `onload`
  // era `async`: el `try/catch` solo envolvía la llamada síncrona, así que un
  // .xlsx corrupto producía una promesa rechazada sin capturar y el usuario no
  // veía ni columnas ni error. Con `await f.arrayBuffer()` el fallo entra en
  // el `catch`. Además ya no se materializa el archivo entero para leer la
  // primera fila: solo se recorre la fila de cabeceras.
  const handleFileUpload = async (f) => {
    if (!f) return;

    setFile(f);
    setColumns([]);
    setSelectedColumn('');
    setLevRowCount(null);
    setLevParsing(true);
    setError("");

    try {
      if (f.name.toLowerCase().endsWith(".csv")) {
        Papa.parse(f, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => {
            const headers = Object.keys(result.data[0] || {});
            setColumns(headers.filter(h => h && !String(h).startsWith("Unnamed")));
            setLevRowCount(result.data.length);
            setLevParsing(false);
          },
          error: () => {
            setLevParsing(false);
            setError("No se pudo leer el CSV. Comprueba que esté bien formado y en UTF-8.");
          },
        });
      } else {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await f.arrayBuffer());
        const worksheet = workbook.worksheets[0];
        const headers = [];
        worksheet.getRow(1).eachCell(cell => headers.push(String(cell.value ?? '')));
        setColumns(headers.filter(h => h && !h.startsWith("Unnamed")));
        setLevRowCount(Math.max((worksheet.actualRowCount || worksheet.rowCount || 1) - 1, 0));
        setLevParsing(false);
      }
    } catch (e) {
      setLevParsing(false);
      setError(`No se pudo leer el archivo: ${e.message}. Si es un .xlsx, ábrelo y vuelve a guardarlo desde Excel.`);
    }
  };

  // Inicia proceso de levantamiento
  const handleProcess = async () => {
    if (!file) {
      setError("Por favor, sube un archivo válido.");
      return;
    }

    if (!selectedColumn) {
      setError("Por favor, selecciona una columna.");
      return;
    }

    if (!companyTypeInput.trim()) {
      setError("Por favor, describe el tipo de industria.");
      return;
    }

    setError("");
    setIsProcessing(true);
    setLevantamientoResult(null);
    setLevPhase({ step: 0, total: 3, label: '' });
    levCancelledRef.current = false;

    try {
      const invento = new Invento(
        medium,
        file,
        selectedColumn,
        companyTypeInput,
        "user@example.com",
        selectedCategoryCount,
        'tematico',
      );

      console.log("Archivo pasado a Invento:", file);
      await invento.loadData(file);
      const result = await invento.generateClusters(setProgress, () => levCancelledRef.current, levCatalogRef, setLevPhase);
      setLevantamientoResult(result);
    } catch (e) {
      if (e.message === 'CANCELLED') {
        setError('');
      } else {
        console.error("Error al generar clusters:", e);
        setError(`Error al procesar: ${e.message}`);
      }
    }

    setIsProcessing(false);
  };

  const handleCancelLev = () => {
    levCancelledRef.current = true;
  };

  const handleLevVerticalChange = async (vertical) => {
    setLevVertical(vertical);
    setLevCatalogRef(null);
    if (!vertical) return;
    setLevCatalogLoading(true);
    try {
      const { data } = await axios.get(`${API_BASE}/api/catalog/reference`, { params: { vertical } });
      setLevCatalogRef(data.referenceText || null);
    } catch (e) {
      console.warn('[catalog/reference] no se pudo cargar la referencia:', e.message);
      setLevCatalogRef(null);
    } finally {
      setLevCatalogLoading(false);
    }
  };

  // Maneja carga de archivos para etiquetado. Mismo arreglo que en
  // Levantamiento: el `onload` asíncrono tampoco estaba capturado aquí, y
  // `Object.keys(result.data[0])` reventaba con un CSV vacío.
  const handleEtiquetadoFileUpload = async (f) => {
    if (!f) return;

    setEtiquetadoFile(f);
    setEtiquetaColumns([]);
    setSelectedEtiquetaColumn('');
    setEtqRowCount(null);
    setEtqParsing(true);
    setEtiquetadoError('');

    try {
      if (f.name.toLowerCase().endsWith(".csv")) {
        Papa.parse(f, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => {
            const headers = Object.keys(result.data[0] || {});
            setEtiquetaColumns(headers.filter(h => h && !String(h).startsWith("Unnamed")));
            setEtqRowCount(result.data.length);
            setEtqParsing(false);
          },
          error: () => {
            setEtqParsing(false);
            setEtiquetadoError("No se pudo leer el CSV. Comprueba que esté bien formado y en UTF-8.");
          },
        });
      } else {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await f.arrayBuffer());
        const worksheet = workbook.worksheets[0];
        const headers = [];
        worksheet.getRow(1).eachCell(cell => headers.push(String(cell.text ?? '')));
        setEtiquetaColumns(headers.filter(h => h && !h.startsWith("Unnamed")));
        setEtqRowCount(Math.max((worksheet.actualRowCount || worksheet.rowCount || 1) - 1, 0));
        setEtqParsing(false);
      }
    } catch (err) {
      setEtqParsing(false);
      setEtiquetadoError(`No se pudo leer el archivo: ${err.message}. Si es un .xlsx, ábrelo y vuelve a guardarlo desde Excel.`);
    }
  };

  // Maneja carga del archivo JSON de categorías
  const handleCategoriasFileUpload = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCategoriasMaster(reader.result);
        const pretty = stringifyCategoriasMaster(parsed);
        setCategoriasFile(file);
        setCategoriasSaved(parsed);
        setCategoriasDraft(pretty);
        setCategoriasEditorError('');
        setCategoriasEditorOpen(true);
        setEtiquetadoError('');
      } catch (err) {
        setCategoriasFile(null);
        setCategoriasSaved(null);
        setCategoriasDraft('');
        setCategoriasEditorError('');
        setEtiquetadoError(err.message || 'Archivo de categorías inválido.');
      }
    };
    reader.onerror = () => setEtiquetadoError('No se pudo leer el archivo de categorías.');
    reader.readAsText(file, 'utf-8');
  };

  const handleSaveCategoriasDraft = () => {
    try {
      const parsed = parseCategoriasMaster(categoriasDraft);
      setCategoriasSaved(parsed);
      setCategoriasDraft(stringifyCategoriasMaster(parsed));
      setCategoriasEditorError('');
      setCategoriasEditorOpen(false);
    } catch (err) {
      setCategoriasEditorError(err.message || 'No se pudo guardar el maestro.');
    }
  };

  const handleDownloadCategorias = () => {
    let source = null;
    try { source = parseCategoriasMaster(categoriasDraft); } catch { source = categoriasSaved; }
    if (!source) {
      setCategoriasEditorError('Corrige el JSON antes de descargarlo.');
      return;
    }
    const blob = new Blob([stringifyCategoriasMaster(source)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = categoriasFile?.name || 'maestro-categorias.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  // Inicia proceso de etiquetado
  const handleEtiquetadoProcess = async () => {
    if (!etiquetadoFile || !selectedEtiquetaColumn || !categoriasSaved) {
      setEtiquetadoError("Sube los datos, el maestro de categorías y selecciona una columna.");
      return;
    }

    setEtiquetadoError("");
    setEtiquetadoStarted(true);
    setEtiquetadoProgress(0);
    etqCancelledRef.current = false;
    if (etiquetadoModelMode === 'prod') setEtiquetadoResultProd(null);
    else setEtiquetadoResultGpt(null);

    try {
      const etiquetador = new Etiquetado();
      await etiquetador.loadData(etiquetadoFile, selectedEtiquetaColumn);
      etiquetador.setCategorias(categoriasSaved);
      etiquetador.setExpertVertical(etiquetadoExpertVertical || null);

      const parsePhrases = (text) =>
        text.split(/\n|;/).map(s => s.trim()).filter(Boolean);
      const ignorePhrases = parsePhrases(ignoreInput);
      const derivePhrases = parsePhrases(deriveInput);
      const rows = await etiquetador.runEtiquetado(
        setEtiquetadoProgress,
        taggingMode, ignorePhrases, derivePhrases, etiquetadoModelMode,
        () => etqCancelledRef.current,
      );
      const payload = {
        results: rows,
        taggingMode,
        textColumn: selectedEtiquetaColumn,
        metadata: {
          source: etiquetadoModelMode === 'prod' ? 'invento-prod' : 'invento-testing',
          datasetRows: rows.length,
          sampleRows: rows.length,
        },
      };
      if (etiquetadoModelMode === 'prod') setEtiquetadoResultProd(payload);
      else setEtiquetadoResultGpt(payload);
    } catch (e) {
      if (e.message !== 'CANCELLED') {
        console.error("Error durante el etiquetado:", e);
        setEtiquetadoError(`Error al etiquetar: ${e.message}`);
      }
    } finally {
      setTimeout(() => setEtiquetadoStarted(false), 500);
    }
  };

  const handleCancelEtq = () => {
    etqCancelledRef.current = true;
  };

  // Resultado activo según modo seleccionado
  const etiquetadoResult = etiquetadoModelMode === 'prod' ? etiquetadoResultProd : etiquetadoResultGpt;

  const handleLevStartOver = () => {
    setFile(null);
    setColumns([]);
    setSelectedColumn('');
    setProgress(0);
    setIsProcessing(false);
    setError('');
    setLevRowCount(null);
    setLevParsing(false);
    setLevantamientoResult(null); // también limpia localStorage vía setter
    setLevFileKey(k => k + 1);
  };

  const handleEtqStartOver = () => {
    setEtiquetadoFile(null);
    setCategoriasFile(null);
    setCategoriasSaved(null);
    setCategoriasDraft('');
    setCategoriasEditorOpen(false);
    setCategoriasEditorError('');
    setEtiquetaColumns([]);
    setSelectedEtiquetaColumn('');
    setEtiquetadoStarted(false);
    setEtiquetadoProgress(0);
    setEtiquetadoError('');
    setEtqRowCount(null);
    setEtqParsing(false);
    setEtiquetadoResultProd(null);
    setEtiquetadoResultGpt(null);
    setEtqFileKey(k => k + 1);
  };

  const handleAutoQAStartOver = () => setAutoQAKey(k => k + 1);

  const navItems = [
    { id: 'levantamiento', label: 'Levantamiento' },
    { id: 'etiquetado',    label: 'Etiquetado' },
    { id: 'autoqa',        label: 'AutoQA', badge: 'Dev' },
    { id: 'blackbox',      label: 'Open The Black Box' },
    { id: 'calculadora',   label: 'Calculadora' },
  ];

  return (
    <AppShell
      navItems={navItems}
      currentView={currentView}
      onNavigate={setCurrentView}
      statusLabel={
        isProcessing
          ? `Levantamiento en curso · ${Math.round(progress)}%`
          : etiquetadoStarted
            ? `Etiquetado en curso · ${Math.round(etiquetadoProgress)}%`
            : ''
      }
    >
        {/* Pestaña: Levantamiento */}
        <div className={`${UI.card} p-6`} style={{ display: currentView === 'levantamiento' ? undefined : 'none' }}>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-ink">Levantamiento de Categorías</h2>
                <p className="text-sm text-ink-muted mt-0.5">Genera una taxonomía de categorías a partir de tus datos.</p>
              </div>
              {(levantamientoResult || file) && (
                <button onClick={handleLevStartOver} className="shrink-0 text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-sm transition-colors">
                  Empezar de nuevo
                </button>
              )}
            </div>

            {error && (
              <div className="mb-4 px-4 py-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Tipo de contenido */}
              <div>
                <label className={UI.label}>Tipo de contenido</label>
                <select value={medium} onChange={(e) => setMedium(e.target.value)} className={UI.input}>
                  <option value="CORREO">Correo Electrónico</option>
                  <option value="RRSS">Redes Sociales</option>
                </select>
              </div>

              {/* Vertical del catálogo + descripción libre */}
              <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={UI.label}>
                    Vertical del catálogo
                    <span className="ml-1 font-normal text-slate-400 text-xs">(base de referencia)</span>
                  </label>
                  <select
                    value={levVertical}
                    onChange={(e) => handleLevVerticalChange(e.target.value)}
                    className={UI.input}
                  >
                    <option value="">— Sin referencia —</option>
                    {expertVerticalOptions.map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  {levCatalogLoading && (
                    <p className="mt-1 text-xs text-indigo-500">Cargando referencia…</p>
                  )}
                  {levCatalogRef && !levCatalogLoading && (
                    <p className="mt-1 text-xs text-emerald-600">
                      ✓ Referencia cargada · Claude usará el catálogo de {levVertical} como guía
                    </p>
                  )}
                  <p className={UI.hint}>
                    Si eliges una vertical, Claude recibirá las categorías y definiciones del sector como orientación para nombrar y agrupar los clusters.
                  </p>
                </div>
                <div>
                  <label className={UI.label}>Tipo de industria</label>
                  <input
                    type="text"
                    placeholder="Ej: Un banco (BCI)"
                    value={companyTypeInput}
                    onChange={(e) => setCompanyTypeInput(e.target.value)}
                    className={UI.input}
                  />
                  <p className={UI.hint}>Descripción libre para contextualizar el clustering.</p>
                </div>
              </div>

              {/* Subir archivo */}
              <div key={levFileKey}>
                <label className={UI.label}>Archivo de datos</label>
                <FileDropzone
                  accept=".csv,.xlsx"
                  maxMB={MAX_DATOS_MB}
                  hint="1 fila = 1 mensaje"
                  file={file}
                  detail={levRowCount != null ? `${levRowCount.toLocaleString('es-CL')} filas` : ''}
                  parsing={levParsing}
                  disabled={isProcessing}
                  onFile={handleFileUpload}
                  onReject={setError}
                  error={Boolean(error) && !file}
                />
              </div>

              {/* Seleccionar columna */}
              {columns.length > 0 && (
                <div>
                  <label className={UI.label}>Columna de texto</label>
                  <select value={selectedColumn} onChange={(e) => setSelectedColumn(e.target.value)} className={UI.input}>
                    <option value="">— Selecciona —</option>
                    {columns.map((col) => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Número de categorías */}
              <div className="md:col-span-2">
                <label className={UI.label}>Número de categorías de salida</label>
                <select
                  value={selectedCategoryCount}
                  onChange={(e) => setSelectedCategoryCount(e.target.value)}
                  className={UI.input}
                >
                  {categoryOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className={UI.hint}>
                  {(() => {
                    switch (selectedCategoryCount) {
                      case '5':
                        return 'Se generarán exactamente 5 categorías principales con hasta 4 subcategorías cada una (~15-20 códigos WMA).';
                      case '10':
                        return 'Se generarán exactamente 10 categorías principales con hasta 4 subcategorías cada una (~30-40 códigos WMA).';
                      case '0':
                        return 'El modelo decidirá la cantidad óptima de categorías (mínimo 10).';
                      case '25':
                        return 'Se generarán exactamente 25 categorías principales con hasta 4 subcategorías cada una (~75-100 códigos WMA).';
                      default:
                        return '';
                    }
                  })()}
                </p>
              </div>
            </div>

            {/* Qué va a pasar al procesar */}
            {levRowCount != null && !isProcessing && (
              <div className="mt-5">
                <FilePreflight
                  stats={[
                    { label: 'filas leídas', value: levRowCount.toLocaleString('es-CL') },
                    { label: 'columnas', value: columns.length },
                    { label: 'columna de texto', value: selectedColumn || '— sin elegir —' },
                    { label: 'contenido', value: medium === 'CORREO' ? 'Correo' : 'RRSS' },
                  ]}
                  note={
                    'Las filas sin texto en la columna elegida se descartan antes de agrupar. '
                    + 'El texto se envía a un proveedor de LLM externo para descubrir las temáticas '
                    + 'y nombrar las categorías.'
                  }
                  warning={!selectedColumn ? 'Elige la columna de texto para poder procesar.' : ''}
                />
              </div>
            )}

            {/* Botón procesar */}
            {selectedColumn && (
              <div className="mt-6 pt-5 border-t border-slate-100">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleProcess}
                    disabled={isProcessing}
                    className={`px-5 py-2 rounded-lg text-sm font-semibold text-white shadow-sm transition-all ${
                      isProcessing
                        ? 'bg-slate-400 cursor-not-allowed'
                        : 'bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98]'
                    }`}
                  >
                    {isProcessing
                      ? levPhase.step > 0
                        ? `Fase ${levPhase.step}/${levPhase.total}`
                        : 'Iniciando…'
                      : 'Procesar'}
                  </button>
                  {isProcessing && (
                    <button
                      onClick={handleCancelLev}
                      className="px-4 py-2 rounded-lg border border-rose-300 bg-white text-rose-600 hover:bg-rose-50 text-sm font-medium shadow-sm transition-colors"
                    >
                      Cancelar
                    </button>
                  )}
                </div>

                {/* Barra de progreso con fases */}
                {isProcessing && (
                  <div className="mt-4 space-y-2">
                    {/* Indicador de fases */}
                    {levPhase.step > 0 && (
                      <div className="flex items-center gap-3">
                        {Array.from({ length: levPhase.total }, (_, i) => {
                          const s = i + 1;
                          const done = s < levPhase.step;
                          const active = s === levPhase.step;
                          return (
                            <div key={s} className="flex items-center gap-1.5">
                              <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold border
                                ${done   ? 'bg-emerald-500 border-emerald-500 text-white'
                                        : active ? 'bg-indigo-600 border-indigo-600 text-white animate-pulse'
                                        : 'bg-white border-slate-300 text-slate-400'}`}>
                                {done ? '✓' : s}
                              </span>
                              <span className={`text-xs ${active ? 'text-indigo-700 font-semibold' : done ? 'text-emerald-600' : 'text-slate-400'}`}>
                                {s === 1 ? 'Temáticas' : s === 2 ? 'Categorías' : 'JSON'}
                              </span>
                              {s < levPhase.total && <span className="text-slate-200 text-xs">›</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {/* Barra de progreso interna de la fase 1 */}
                    {levPhase.step === 1 && (
                      <div className="space-y-1">
                        <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-1.5 rounded-full bg-indigo-500 transition-all duration-300"
                            style={{ width: `${Math.round(progress)}%` }}
                          />
                        </div>
                        <p className="text-xs text-slate-400">{Math.round(progress)}% · {levPhase.label}</p>
                      </div>
                    )}
                    {levPhase.step > 1 && (
                      <p className="text-xs text-indigo-600">{levPhase.label}…</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Resultados de Levantamiento */}
            {levantamientoResult && !isProcessing && (
              <div className="mt-6">
                <ResultsView {...levantamientoResult} />
              </div>
            )}
          </div>

        {/* Pestaña: Etiquetado */}
        <div className={`${UI.card} p-6`} style={{ display: currentView === 'etiquetado' ? undefined : 'none' }}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-xl font-bold text-[#171433]">Módulo de Etiquetado</h2>
                <p className="text-sm text-slate-500 mt-0.5">Sube los datos y el JSON de categorías para clasificar cada mensaje. El maestro cargado es el que se envía al modelo.</p>
              </div>
              {(etiquetadoResult || etiquetadoFile) && (
                <button onClick={handleEtqStartOver} className="shrink-0 text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-sm transition-colors">
                  Empezar de nuevo
                </button>
              )}
            </div>

            {/* Selector de modelo */}
            <div className="mb-5">
              <label className={UI.label}>Modelo</label>
              <div className="flex gap-3">
                {[
                  { value: 'prod', label: 'Prod',    desc: 'GPT 4.1 · Maestro JSON cargado' },
                  { value: 'gpt',  label: 'Testing', desc: 'GPT 5.2 · Nuevo modelo' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEtiquetadoModelMode(opt.value)}
                    className={`flex-1 py-2.5 px-4 rounded-xl border text-sm font-semibold text-left transition-all ${
                      etiquetadoModelMode === opt.value
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-700 ring-2 ring-emerald-100'
                        : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    <span className="block">{opt.label}</span>
                    <span className="block text-xs font-normal mt-0.5 opacity-70">{opt.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Seleccionar modo de etiquetado */}
              <div>
                <label className={UI.label}>Modo de etiquetado</label>
                <select value={taggingMode} onChange={(e) => setTaggingMode(e.target.value)} className={UI.input}>
                  {taggingModeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Modo sugerencia: solo aplica para Testing (GPT 5.2) */}
              {etiquetadoModelMode === 'gpt' && (
                <div>
                  <label className={UI.label}>
                    Modo sugerencia
                    <span className="ml-1 text-xs text-slate-400 font-normal">para casos "Otros"</span>
                  </label>
                  <select
                    value={etiquetadoExpertVertical}
                    onChange={(e) => setEtiquetadoExpertVertical(e.target.value)}
                    className={UI.input}
                  >
                    <option value="">— Desactivado —</option>
                    {expertVerticalOptions.map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  <p className={UI.hint}>
                    Cuando un mensaje cae en <span className="font-mono">WMA000</span> (Otros),
                    el sistema busca en el catálogo del vertical elegido y propone hasta 3 caminos alternativos
                    para iterar la taxonomía.
                  </p>
                </div>
              )}

              {/* Subir archivo de datos */}
              <div key={etqFileKey}>
                <label className={UI.label}>Archivo de datos</label>
                <FileDropzone
                  accept=".csv,.xlsx"
                  maxMB={MAX_DATOS_MB}
                  hint="1 fila = 1 mensaje"
                  file={etiquetadoFile}
                  detail={etqRowCount != null ? `${etqRowCount.toLocaleString('es-CL')} filas` : ''}
                  parsing={etqParsing}
                  disabled={etiquetadoStarted}
                  onFile={handleEtiquetadoFileUpload}
                  onReject={setEtiquetadoError}
                  error={Boolean(etiquetadoError) && !etiquetadoFile}
                />
              </div>

              {/* Seleccionar columna para etiquetado */}
              {etiquetaColumns.length > 0 && (
                <div>
                  <label className={UI.label}>Columna de texto</label>
                  <select
                    value={selectedEtiquetaColumn}
                    onChange={(e) => setSelectedEtiquetaColumn(e.target.value)}
                    className={UI.input}
                  >
                    <option value="">— Selecciona —</option>
                    {etiquetaColumns.map((col) => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Subir archivo JSON de categorías */}
              <div>
                <label className={UI.label}>Archivo de categorías (.json)</label>
                <FileDropzone
                  key={`categorias-${etqFileKey}`}
                  accept=".json"
                  maxMB={MAX_JSON_MB}
                  hint="maestro de categorías"
                  file={categoriasFile}
                  detail={categoriasSaved ? `${Object.keys(categoriasSaved).length} categorías` : ''}
                  disabled={etiquetadoStarted}
                  onFile={handleCategoriasFileUpload}
                  onReject={setEtiquetadoError}
                />
                {categoriasSaved ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className={UI.hint + ' m-0'}>
                      {categoriasFile?.name || 'maestro.json'} · {Object.keys(categoriasSaved).length} categorías
                    </p>
                    <button
                      type="button"
                      onClick={() => { setCategoriasEditorError(''); setCategoriasEditorOpen(true); }}
                      className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                    >
                      Ver / editar maestro
                    </button>
                  </div>
                ) : (
                  <p className={UI.hint}>Este JSON es el maestro que usa el modelo. Tras cargarlo puedes editarlo y guardarlo para el procesado.</p>
                )}
              </div>
            </div>

            {/* Frases opcionales para Ignorar y Derivar */}
 {/*            <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-gray-700 mb-2">Ignorar (frases separadas por ';' o nuevas líneas):</label>
                <textarea
                  value={ignoreInput}
                  onChange={(e) => setIgnoreInput(e.target.value)}
                  rows={4}
                  className="block w-full p-2 border rounded"
                  placeholder="ej: tarro de jurel; oferta no solicitada"
                />
                <p className="mt-1 text-xs text-gray-500">Si alguna frase aparece, se responderá con WMI000 - Ignorar.</p>
              </div>
              <div>
                <label className="block text-gray-700 mb-2">Derivar (frases separadas por ';' o nuevas líneas):</label>
                <textarea
                  value={deriveInput}
                  onChange={(e) => setDeriveInput(e.target.value)}
                  rows={4}
                  className="block w-full p-2 border rounded"
                  placeholder="ej: tarro de jurel; oferta no solicitada"
                />
                <p className="mt-1 text-xs text-gray-500">Si alguna frase aparece, se responderá con WMD000 - Derivar.</p>
              </div>
            </div>
 */}
            {/* Mensaje de error */}
            {etiquetadoError && (
              <div className="mt-4 px-4 py-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-sm">
                {etiquetadoError}
              </div>
            )}

            {/* Qué va a pasar al etiquetar */}
            {etqRowCount != null && !etiquetadoStarted && (
              <div className="mt-5">
                <FilePreflight
                  stats={[
                    { label: 'filas leídas', value: etqRowCount.toLocaleString('es-CL') },
                    { label: 'columna de texto', value: selectedEtiquetaColumn || '— sin elegir —' },
                    { label: 'categorías del maestro', value: categoriasSaved ? Object.keys(categoriasSaved).length : '— sin cargar —' },
                    { label: 'llamadas al modelo', value: `≈ ${estimarLlamadas(etqRowCount, ETQ_BATCH_SIZE).toLocaleString('es-CL')}` },
                  ]}
                  note={
                    `Se clasifican ${etqRowCount.toLocaleString('es-CL')} mensajes en lotes de ${ETQ_BATCH_SIZE}. `
                    + 'Los textos vacíos se asignan a WMA000 sin consumir llamadas. El texto se envía a un '
                    + 'proveedor de LLM externo.'
                  }
                  warning={!categoriasSaved ? 'Falta el maestro de categorías: es el que se envía al modelo.' : ''}
                />
              </div>
            )}

            {/* Botón iniciar etiquetado */}
            <div className="mt-6 pt-5 border-t border-slate-100">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleEtiquetadoProcess}
                  disabled={
                    !etiquetadoFile
                    || !selectedEtiquetaColumn
                    || !categoriasSaved
                    || etiquetadoStarted
                  }
                  className={`px-5 py-2 rounded-lg text-sm font-semibold text-white shadow-sm transition-all ${
                    !etiquetadoFile
                    || !selectedEtiquetaColumn
                    || !categoriasSaved
                    || etiquetadoStarted
                      ? 'bg-slate-300 text-slate-500 cursor-not-allowed shadow-none'
                      : 'bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98]'
                  }`}
                >
                  {etiquetadoStarted ? `Procesando… ${Math.round(etiquetadoProgress)}%` : 'Iniciar Etiquetado'}
                </button>
                {etiquetadoStarted && (
                  <button
                    onClick={handleCancelEtq}
                    className="px-4 py-2 rounded-lg border border-rose-300 bg-white text-rose-600 hover:bg-rose-50 text-sm font-medium shadow-sm transition-colors"
                  >
                    Cancelar
                  </button>
                )}
              </div>

              {/* Barra de progreso */}
              {etiquetadoStarted && (
                <div className="mt-4">
                  <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${etiquetadoProgress}%` }}
                    ></div>
                  </div>
                </div>
              )}
            </div>

            {/* Resultados de Etiquetado */}
            {etiquetadoResult && !etiquetadoStarted && (
              <div className="mt-6">
                <EtiquetadoResultsView
                  results={etiquetadoResult.results}
                  taggingMode={etiquetadoResult.taggingMode}
                  textColumn={etiquetadoResult.textColumn}
                  metadata={etiquetadoResult.metadata}
                />
              </div>
            )}
          </div>

        {/* Pestaña: AutoQA */}
        <div style={{ display: currentView === 'autoqa' ? undefined : 'none' }}>
          <AutoQA key={autoQAKey} />
          {currentView === 'autoqa' && (
            <div className="flex justify-end mt-4">
              <button onClick={handleAutoQAStartOver} className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-sm transition-colors">
                Empezar de nuevo
              </button>
            </div>
          )}
        </div>

        {/* Pestaña: Open The Black Box — sin card extra: OTBB arma su propio layout */}
        {currentView === 'blackbox' && (
          <OtbbErrorBoundary>
            <OpenBlackBox />
          </OtbbErrorBoundary>
        )}

        {currentView === 'calculadora' && <Calculadora />}

        <CategoriasEditor
          open={categoriasEditorOpen}
          fileName={categoriasFile?.name}
          draft={categoriasDraft}
          error={categoriasEditorError}
          dirty={!!categoriasSaved && categoriasDraft !== stringifyCategoriasMaster(categoriasSaved)}
          savedCount={categoriasSaved ? Object.keys(categoriasSaved).length : 0}
          onChange={(value) => { setCategoriasEditorError(''); setCategoriasDraft(value); }}
          onSave={handleSaveCategoriasDraft}
          onDownload={handleDownloadCategorias}
          onClose={() => setCategoriasEditorOpen(false)}
        />
    </AppShell>
  );
}