// src/otbb-report-config.jsx
// Pantalla intermedia del flujo OTBB: "Resultados" → "Configurar reporte" →
// "Exportación". Sube el maestro ya etiquetado a otbb-service, pinta el
// universo de productos detectado y arma el ReportConfig (sección 6 del
// diseño de otbb-service) antes de pasar a la exportación.

import { useEffect, useState } from 'react';
import { uploadOtbbMasterForReport } from './otbb-report';

const ENFOQUE_OPTIONS = [
  { value: 'gestion', label: 'Gestión', hint: 'funnel de servicio/retención' },
  { value: 'originacion', label: 'Originación', hint: 'funnel de venta nueva' },
  { value: 'ambos', label: 'Ambos', hint: 'en paralelo, sin comparar cifra a cifra' },
];

const TASA_OPTIONS = [
  { value: 'observada', label: 'Observada', hint: 'solo la de esta muestra' },
  { value: 'escenarios', label: 'Escenarios', hint: 'pesimista / conservador / ideal' },
  { value: 'auto', label: 'Automática', hint: 'el modelo la propone y la declara' },
];

const inputClass = 'w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40';
const labelClass = 'block text-xs font-medium text-ink-muted mb-1';

function buildWorkbookFilename(sourceBaseName) {
  return `maestro_${sourceBaseName || 'otbb'}.xlsx`;
}

export default function OtbbReportConfig({ getWorkbookBuffer, sourceBaseName, onBack, onNext }) {
  const [uploadState, setUploadState] = useState('idle'); // idle | uploading | ready | error
  const [uploadError, setUploadError] = useState('');
  const [uploadId, setUploadId] = useState('');
  const [universo, setUniverso] = useState([]);

  const [cliente, setCliente] = useState('');
  const [periodoLabel, setPeriodoLabel] = useState('');
  const [productosSeleccionados, setProductosSeleccionados] = useState([]);
  const [enfoque, setEnfoque] = useState('gestion');
  const [tasaConversion, setTasaConversion] = useState('observada');
  const [escenarios, setEscenarios] = useState({ pesimista: '', conservador: '', ideal: '' });
  const [poblacionTotalMensual, setPoblacionTotalMensual] = useState('');
  const [nEjecutivos, setNEjecutivos] = useState('');
  const [mesesDelCorte, setMesesDelCorte] = useState(1);
  const [notasCliente, setNotasCliente] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setUploadState('uploading');
      setUploadError('');
      try {
        const buffer = await getWorkbookBuffer();
        if (cancelled) return;
        const result = await uploadOtbbMasterForReport(buffer, buildWorkbookFilename(sourceBaseName));
        if (cancelled) return;
        setUploadId(result.upload_id || '');
        const detected = result.universo_detectado || [];
        setUniverso(detected);
        setProductosSeleccionados(detected.map(u => u.producto));
        setUploadState('ready');
      } catch (e) {
        if (cancelled) return;
        setUploadError(e.response?.data?.error || e.message || 'No se pudo conectar con otbb-service.');
        setUploadState('error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleProducto = (producto) => {
    setProductosSeleccionados(prev => prev.includes(producto)
      ? prev.filter(p => p !== producto)
      : [...prev, producto]);
  };

  const canContinue = uploadState === 'ready'
    && cliente.trim().length > 0
    && periodoLabel.trim().length > 0
    && productosSeleccionados.length > 0;

  const handleNext = () => {
    if (!canContinue) return;
    const escenariosRecuperacion = tasaConversion === 'escenarios'
      ? {
          pesimista: Number(escenarios.pesimista) || 0,
          conservador: Number(escenarios.conservador) || 0,
          ideal: Number(escenarios.ideal) || 0,
        }
      : null;

    onNext({
      cliente: cliente.trim(),
      periodo_label: periodoLabel.trim(),
      upload_id: uploadId,
      productos_seleccionados: productosSeleccionados,
      enfoque,
      tasa_conversion: tasaConversion,
      escenarios_recuperacion: escenariosRecuperacion,
      poblacion_total_mensual: poblacionTotalMensual ? Number(poblacionTotalMensual) : null,
      n_ejecutivos_o_buzones: nEjecutivos ? Number(nEjecutivos) : null,
      meses_del_corte: Number(mesesDelCorte) || 1,
      notas_cliente: notasCliente.trim() || null,
    });
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-semibold text-ink">Configurar reporte PDF</p>
        <p className="text-xs text-ink-muted mt-0.5">
          Define el alcance y los parámetros del reporte OTBB antes de generarlo. Se redacta sobre el
          mismo maestro ya etiquetado — nada se vuelve a calcular ni a inventar.
        </p>
      </div>

      {uploadState === 'error' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          otbb-service no está disponible: {uploadError}
          <br />Puedes seguir completando el formulario, pero no vas a poder continuar hasta que el
          servicio esté configurado y el maestro se suba correctamente.
        </div>
      )}

      <div className="bg-surface border border-line rounded-panel shadow-panel p-5 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Cliente</label>
            <input className={inputClass} value={cliente} onChange={e => setCliente(e.target.value)}
              placeholder="ej. Invex" />
          </div>
          <div>
            <label className={labelClass}>Período</label>
            <input className={inputClass} value={periodoLabel} onChange={e => setPeriodoLabel(e.target.value)}
              placeholder="ej. Junio 2026" />
          </div>
        </div>

        <div>
          <label className={labelClass}>Productos a analizar</label>
          {uploadState === 'uploading' && (
            <p className="text-xs text-ink-muted">Detectando universo de productos…</p>
          )}
          {uploadState !== 'uploading' && universo.length === 0 && (
            <p className="text-xs text-ink-muted">Sin universo detectado todavía.</p>
          )}
          {universo.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {universo.map(u => (
                <label key={u.producto} className="flex items-center gap-2 text-xs text-ink border border-line rounded-lg px-2.5 py-1.5">
                  <input
                    type="checkbox"
                    checked={productosSeleccionados.includes(u.producto)}
                    onChange={() => toggleProducto(u.producto)}
                  />
                  {u.producto} <span className="text-ink-muted">({u.n_hilos})</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className={labelClass}>Enfoque</label>
          <div className="flex flex-wrap gap-2">
            {ENFOQUE_OPTIONS.map(o => (
              <button key={o.value} type="button" onClick={() => setEnfoque(o.value)}
                className={`px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors
                  ${enfoque === o.value ? 'border-accent bg-accent/10 text-navy' : 'border-line text-ink-muted hover:text-ink'}`}
                title={o.hint}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className={labelClass}>Tasa de conversión</label>
          <div className="flex flex-wrap gap-2">
            {TASA_OPTIONS.map(o => (
              <button key={o.value} type="button" onClick={() => setTasaConversion(o.value)}
                className={`px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors
                  ${tasaConversion === o.value ? 'border-accent bg-accent/10 text-navy' : 'border-line text-ink-muted hover:text-ink'}`}
                title={o.hint}>
                {o.label}
              </button>
            ))}
          </div>
          {tasaConversion === 'escenarios' && (
            <div className="grid grid-cols-3 gap-3 mt-3">
              {['pesimista', 'conservador', 'ideal'].map(key => (
                <div key={key}>
                  <label className={labelClass}>{key[0].toUpperCase() + key.slice(1)} (%)</label>
                  <input type="number" step="0.01" className={inputClass}
                    value={escenarios[key]}
                    onChange={e => setEscenarios(prev => ({ ...prev, [key]: e.target.value }))} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>Población total mensual (opcional)</label>
            <input type="number" className={inputClass} value={poblacionTotalMensual}
              onChange={e => setPoblacionTotalMensual(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>N° ejecutivos / buzones (opcional)</label>
            <input type="number" className={inputClass} value={nEjecutivos}
              onChange={e => setNEjecutivos(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Meses del corte</label>
            <input type="number" min={1} className={inputClass} value={mesesDelCorte}
              onChange={e => setMesesDelCorte(e.target.value)} />
          </div>
        </div>

        <div>
          <label className={labelClass}>Notas para el cliente (opcional)</label>
          <textarea className={inputClass} rows={3} value={notasCliente}
            onChange={e => setNotasCliente(e.target.value)} />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <button type="button" onClick={onBack}
          className="px-3.5 py-1.5 rounded-xl border border-line text-ink hover:bg-canvas text-xs font-semibold transition-colors">
          ← Volver a resultados
        </button>
        <button type="button" onClick={handleNext} disabled={!canContinue}
          className="px-3.5 py-1.5 rounded-xl bg-accent text-navy hover:brightness-95 text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          Continuar a exportación →
        </button>
      </div>
    </div>
  );
}
