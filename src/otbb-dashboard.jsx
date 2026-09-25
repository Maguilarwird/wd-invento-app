import { useMemo, useState } from 'react';
import {
  applyFilters,
  availablePeriods,
  availableProductos,
  getDerivacionStats,
  getDerivacionSummary,
  getFlowAnalytics,
  getFrictionsByStage,
  getSankeyFlowsSplit,
  getSankeyFooterStats,
  getThreadAnalytics,
  getThreadLengthDistribution,
  getTopicsByStage,
  getWaitingStats,
  globalFrictionLegend,
  journeyOf,
  pct,
  shortFlowLabel,
  stageFunnel,
} from './otbb-analytics';

// ─── Utilidades ───────────────────────────────────────────────────────────────

function fmt(n) {
  return Number(n || 0).toLocaleString('es-CL');
}

// Rampa naranja → navy → azul → grises. El orden importa: la leyenda va de
// mayor a menor menciones, así que las fricciones dominantes toman los tonos
// saturados y la cola larga se apaga en gris.
const FRICTION_COLORS = [
  '#F97316', // naranja
  '#0F172A', // navy casi negro
  '#2544B8', // azul saturado
  '#3B5BDB', // azul medio
  '#4A5A82', // azul apagado
  '#64748B', // slate
  '#8592A8', // gris azulado
  '#A8B3C4', // gris claro
  '#C5CCD8', // gris más claro
  '#DDE2E8', // gris muy claro
];

/**
 * Dashboard de resultados OTBB (analítica inicial / conversation intelligence).
 * Compartido entre modo Cliente y Usuario. El parent decide si además muestra
 * el análisis de catálogo y la exportación.
 */
export default function OtbbThreadDashboard({
  rows = [],
  onExportMaestro,
  onReset,
}) {
  const [filters, setFilters] = useState({ periodo: '', producto: '', canal: '' });
  const [selectedStage, setSelectedStage] = useState('');

  const periods = useMemo(() => availablePeriods(rows), [rows]);
  const productos = useMemo(() => availableProductos(rows), [rows]);

  // Filas filtradas por periodo + producto + canal
  const view = useMemo(() => applyFilters(rows, filters), [rows, filters]);

  // Analytics principales (embudo / fricción / sankey usan el corte global)
  const analytics = useMemo(() => getFlowAnalytics(view), [view]);
  const threadStats = useMemo(() => getThreadAnalytics(view), [view]);
  const stages = useMemo(() => stageFunnel(view), [view]);
  const frictionsByStage = useMemo(() => getFrictionsByStage(view), [view]);
  const sankeySplit = useMemo(() => getSankeyFlowsSplit(view), [view]);
  const legend = useMemo(() => globalFrictionLegend(frictionsByStage), [frictionsByStage]);

  // Temas / composición / largo se adaptan al click del embudo
  const stageView = useMemo(() => {
    if (!selectedStage) return view;
    return view.filter(row => journeyOf(row) === selectedStage);
  }, [view, selectedStage]);

  const waitingStats = useMemo(() => getWaitingStats(stageView), [stageView]);
  const waitingStatsGlobal = useMemo(() => getWaitingStats(view), [view]);
  const derivacionStats = useMemo(() => getDerivacionStats(view), [view]);
  const derivacionSummary = useMemo(() => getDerivacionSummary(view), [view]);
  const lengthDist = useMemo(() => getThreadLengthDistribution(stageView), [stageView]);
  const topicsByStage = useMemo(() => getTopicsByStage(view, selectedStage), [view, selectedStage]);

  const { total, funnel } = analytics;
  const base = funnel[0]?.n || 0;

  // KPI: total de mensajes en todos los hilos
  const totalMensajes = useMemo(
    () => view.reduce((s, r) => s + (Number(r.n_mensajes_hilo) || 0), 0),
    [view]
  );

  const handleStageSelect = (stage) => {
    setSelectedStage(prev => prev === stage ? '' : stage);
  };

  const resetFilters = () => setFilters({ periodo: '', producto: '', canal: '' });

  const kpis = [
    {
      label: 'Conversaciones analizadas',
      value: fmt(total),
      hint: filters.periodo || filters.producto ? `${filters.periodo} ${filters.producto}`.trim() : 'Todos los segmentos',
      primary: true,
    },
    {
      label: 'Hilos analizados',
      value: fmt(totalMensajes),
      hint: `${filters.periodo || 'todos los períodos'}`,
    },
    {
      label: 'Cerrados',
      value: `${pct(threadStats.cerrados, base)}%`,
      hint: `${fmt(threadStats.cerrados)} de ${fmt(base)} en base`,
    },
    {
      // La unidad va pegada a la cifra: "2.2" solo, con el "días" escondido en
      // la glosa de abajo, se lee como un porcentaje o un conteo.
      label: 'Resolución',
      value: `${threadStats.avgResolutionDays} días`,
      hint: 'SLA 2 días',
    },
    {
      label: 'Insistencia',
      value: `${pct(threadStats.insistencia, total)}%`,
      hint: `${fmt(threadStats.insistencia)} conversaciones forzaron seguimiento`,
    },
    {
      label: 'Derivaciones',
      value: `${pct(derivacionStats.n, total)}%`,
      hint: `${fmt(derivacionSummary.totalDerivaciones)} reenvíos internos en ${fmt(derivacionStats.n)} hilos`,
    },
    {
      // Porcentaje arriba y conteo abajo, igual que el resto de las tarjetas
      // (Cerrados, Insistencia, Derivaciones): con el conteo arriba, esta era la
      // única que se leía en otra escala y no se podía comparar de un vistazo.
      label: 'Esperando al banco',
      value: `${pct(waitingStatsGlobal.esperandoBanco, total)}%`,
      hint: `${fmt(waitingStatsGlobal.esperandoBanco)} conversaciones del total`,
      accent: true,
    },
  ];

  return (
    <div className="space-y-5">
      {/* ── Filter bar ──────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-panel shadow-panel px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filters.periodo}
            onChange={e => setFilters(f => ({ ...f, periodo: e.target.value }))}
            className="rounded-xl border border-line bg-white text-xs text-ink px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-navy/30"
          >
            <option value="">Periodo: Todos</option>
            {periods.map(p => (
              <option key={p} value={p}>Periodo: {formatPeriod(p)}</option>
            ))}
          </select>

          <select
            value={filters.producto}
            onChange={e => setFilters(f => ({ ...f, producto: e.target.value }))}
            className="rounded-xl border border-line bg-white text-xs text-ink px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-navy/30"
          >
            <option value="">Producto: Todos</option>
            {productos.map(({ product }) => (
              <option key={product} value={product}>Producto: {product}</option>
            ))}
          </select>

          <select
            value={filters.canal}
            onChange={e => setFilters(f => ({ ...f, canal: e.target.value }))}
            className="rounded-xl border border-line bg-white text-xs text-ink px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-navy/30"
          >
            <option value="">Canal: Todos</option>
            <option value="email">Canal: Email</option>
          </select>

          {(filters.periodo || filters.producto || filters.canal || selectedStage) && (
            <button
              type="button"
              onClick={() => {
                resetFilters();
                setSelectedStage('');
              }}
              className="text-xs text-navy/60 hover:text-navy font-medium"
            >
              limpiar
            </button>
          )}

          {selectedStage && (
            <button
              type="button"
              onClick={() => setSelectedStage('')}
              className="rounded-full bg-navy text-surface text-[11px] font-semibold px-2.5 py-1 hover:brightness-110"
            >
              {selectedStage} ×
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {onExportMaestro && (
            <button
              type="button"
              onClick={onExportMaestro}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-line bg-white text-ink hover:bg-canvas text-xs font-semibold transition-colors"
              title="Exportar maestro"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              exportar
            </button>
          )}

          {/* Placeholder: la generación de informe todavía no está implementada */}
          <span
            className="px-3.5 py-1.5 rounded-xl bg-accent/40 text-navy/50 text-xs font-semibold select-none cursor-default"
            title="En desarrollo"
          >
            generar informe
          </span>
        </div>
      </div>

      {!total ? (
        <div className="bg-surface border border-line rounded-panel shadow-panel p-6 text-sm text-ink-muted">
          El filtro activo no deja conversaciones. Cambia el período o el producto.
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
            {kpis.map(card => (
              <div
                key={card.label}
                className={`rounded-panel px-4 py-3 shadow-sm border ${
                  card.primary || card.accent
                    ? 'bg-navy border-navy text-surface'
                    : 'bg-surface border-line'
                }`}
              >
                <p className={`text-[10px] uppercase tracking-wide font-semibold leading-tight ${
                  card.primary || card.accent ? 'text-white/60' : 'text-ink-muted'
                }`}>
                  {card.label}
                </p>
                <p className={`text-2xl font-bold mt-1 tabular-nums leading-none ${
                  card.accent ? 'text-accent' : ''
                }`}>
                  {card.value}
                </p>
                <p className={`text-[10px] mt-1.5 truncate ${
                  card.primary || card.accent ? 'text-white/50' : 'text-ink-muted'
                }`} title={card.hint}>
                  {card.hint}
                </p>
              </div>
            ))}
          </div>

          {/* Nivel 1 — Embudo (ancho completo) */}
          <StageFunnel stages={stages} selectedStage={selectedStage} onSelect={handleStageSelect} />

          {/* Nivel 2 — Fricción por Embudo */}
          <FrictionsByStage frictions={frictionsByStage} legend={legend} />

          {/* Nivel 3 — Historia del dato (Sankey Inbound | Outbound) */}
          <SankeySection split={sankeySplit} />

          {/* Temas por etapa — vinculado al click del embudo */}
          <TopicsByStagePanel
            topics={topicsByStage}
            selectedStage={selectedStage}
            onClearStage={() => setSelectedStage('')}
          />

          {/* Composición + Largo del hilo */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CompositionPanel stats={waitingStats} selectedStage={selectedStage} />
            <ThreadLengthPanel distribution={lengthDist} selectedStage={selectedStage} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPeriod(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const MONTHS = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  const name = MONTHS[parseInt(m, 10) - 1] || m;
  return `${name} ${y}`;
}

// ─── StageFunnel ──────────────────────────────────────────────────────────────

function StageFunnel({ stages, selectedStage, onSelect }) {
  const max = Math.max(1, ...stages.map(s => s.n));
  return (
    <div className="bg-surface border border-line rounded-panel shadow-panel p-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Nivel 1</p>
          <p className="text-sm font-semibold text-ink mt-0.5">Embudo del journey</p>
        </div>
        <p className="text-[11px] text-ink-muted">click en una etapa para filtrar temas, composición y largo</p>
      </div>
      <div className="space-y-2">
        {stages.map(stage => {
          const active = selectedStage === stage.stage;
          const widthPct = Math.max(2, Math.round((stage.n / max) * 100));
          return (
            <div key={stage.stage}>
              <button
                type="button"
                onClick={() => onSelect(stage.stage)}
                className={`w-full grid grid-cols-[180px_1fr_70px] gap-3 items-center text-left rounded-xl px-2 py-2 border-l-2 transition-colors ${
                  active ? 'border-accent bg-canvas' : 'border-transparent hover:bg-canvas'
                }`}
              >
                <span className={`text-xs truncate ${active ? 'font-bold text-ink' : 'text-ink'}`} title={stage.stage}>
                  {stage.stage}
                </span>
                <span className="h-6 rounded-md bg-line/40 overflow-hidden">
                  <span className="block h-full rounded-md bg-navy" style={{ width: `${widthPct}%` }} />
                </span>
                <span className="text-xs font-semibold tabular-nums text-ink text-right">{fmt(stage.n)}</span>
              </button>
              {stage.casoActivo > 0 && (
                <p className="text-[10px] text-ink-muted pl-[196px] pb-0.5">
                  <span className="text-ink-soft">↓ {stage.pctVisible}% avanza</span>
                  {stage.apagados > 0 && (
                    <> · <span className="text-rose-500 font-semibold">{fmt(stage.apagados)} caen aquí</span></>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── FrictionsByStage ─────────────────────────────────────────────────────────

function FrictionsByStage({ frictions, legend }) {
  const [isolated, setIsolated] = useState(null);

  if (!frictions.length || !legend.length) return null;

  const colorMap = new Map(legend.map((f, i) => [f.id, FRICTION_COLORS[i % FRICTION_COLORS.length]]));

  return (
    <div className="bg-surface border border-line rounded-panel shadow-panel p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Nivel 2</p>
          <p className="text-sm font-semibold text-ink mt-0.5">Fricción por Embudo</p>
        </div>
        <p className="text-[11px] text-ink-muted">click en la leyenda para aislar una fricción</p>
      </div>

      {/* Leyenda */}
      <div className="flex flex-wrap gap-2 mb-4">
        {legend.map((f, i) => {
          const color = colorMap.get(f.id);
          const active = isolated === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setIsolated(prev => prev === f.id ? null : f.id)}
              className={`flex items-center gap-1.5 text-[11px] rounded-full px-2.5 py-1 border transition-colors ${
                active ? 'border-transparent ring-1 ring-navy/40 bg-canvas' : 'border-line hover:bg-canvas'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
              <span className="text-ink font-medium truncate max-w-[160px]" title={f.nombre}>{f.nombre}</span>
              <span className="text-ink-muted tabular-nums">{fmt(f.n)}</span>
            </button>
          );
        })}
      </div>

      {/* Tabla de barras */}
      <div className="space-y-1">
        <div className="grid grid-cols-[150px_1fr_80px_80px] gap-2 mb-1">
          <span className="text-[10px] uppercase font-semibold tracking-wide text-ink-muted">Etapa</span>
          <span className="text-[10px] uppercase font-semibold tracking-wide text-ink-muted">Composición de la fricción</span>
          <span className="text-[10px] uppercase font-semibold tracking-wide text-ink-muted text-right">Menciones</span>
          <span className="text-[10px] uppercase font-semibold tracking-wide text-ink-muted text-right">Sobre hilos</span>
        </div>
        {frictions.map(row => {
          const displayed = isolated ? row.frictions.filter(f => f.id === isolated) : row.frictions;
          const maxMentions = Math.max(1, ...frictions.map(r => r.totalMentions));
          const barWidth = Math.max(2, Math.round((row.totalMentions / maxMentions) * 100));
          return (
            <div key={row.stage} className="grid grid-cols-[150px_1fr_80px_80px] gap-2 items-center py-1.5 border-t border-line/40">
              <span className="text-xs text-ink truncate" title={row.stage}>{row.stage}</span>
              <span
                className="h-5 rounded overflow-hidden bg-line/20 relative"
                style={{ width: '100%' }}
              >
                {displayed.length > 0 ? (
                  <FrictionBar frictions={displayed} total={row.totalMentions} colorMap={colorMap} isolated={isolated} />
                ) : (
                  <span className="block h-full bg-line/30" style={{ width: `${barWidth}%` }} />
                )}
              </span>
              <span className="text-xs font-semibold tabular-nums text-ink text-right">{fmt(row.totalMentions)}</span>
              <span className="text-xs text-ink-muted tabular-nums text-right">
                {pct(row.frictions.reduce((s, f) => s + (f.n > 0 ? 1 : 0), 0), row.total)}%
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-ink-muted">
        Una conversación puede tener más de una fricción, así que las menciones superan la cantidad de hilos afectados.
      </p>
    </div>
  );
}

function FrictionBar({ frictions, total, colorMap, isolated }) {
  if (!frictions.length || !total) return null;
  const widths = frictions.map(f => pct(f.n, total));
  return (
    <>
      {frictions.map((f, index) => {
        const w = widths[index];
        const left = widths.slice(0, index).reduce((sum, value) => sum + value, 0);
        return (
          <span
            key={f.id}
            className="absolute top-0 bottom-0 rounded-sm"
            style={{ left: `${left}%`, width: `${w}%`, background: colorMap.get(f.id) || '#94A3B8' }}
            title={`${f.nombre}: ${f.n}`}
          />
        );
      })}
    </>
  );
}

// ─── SankeySection ────────────────────────────────────────────────────────────

function SankeySection({ split }) {
  const { inbound, outbound } = split || {};
  const hasData = (inbound?.nodes?.length || 0) + (outbound?.nodes?.length || 0) > 0;
  if (!hasData) return null;

  return (
    <div className="bg-surface border border-line rounded-panel shadow-panel p-4">
      <div className="mb-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Nivel 3</p>
        <p className="text-sm font-semibold text-ink mt-0.5">Historia del dato</p>
      </div>
      <div className="grid grid-cols-1 gap-4">
        <SankeyPanel
          title="Inbound"
          subtitle="El cliente inició el contacto"
          accent="inbound"
          panel={inbound}
        />
        <SankeyPanel
          title="Outbound"
          subtitle="El banco inició el contacto"
          accent="outbound"
          panel={outbound}
        />
      </div>
    </div>
  );
}

function SankeyPanel({ title, subtitle, accent, panel }) {
  const { nodes = [], links = [], total = 0, columnLabels = [], analytics = {} } = panel || {};
  const footer = getSankeyFooterStats([], analytics);
  const accentBar = accent === 'inbound' ? 'bg-navy' : 'bg-slate-500';

  if (!nodes.length) {
    return (
      <div className="border border-line rounded-xl overflow-hidden flex flex-col min-h-[280px]">
        <div className={`h-1 ${accentBar}`} />
        <div className="p-4 flex-1 flex flex-col">
          <SankeyPanelHeader title={title} subtitle={subtitle} total={0} />
          <p className="text-xs text-ink-muted text-center mt-auto mb-auto py-10">
            Sin hilos en este corte
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-line rounded-xl overflow-hidden flex flex-col">
      <div className={`h-1 ${accentBar}`} />
      <div className="p-3 pb-0">
        <SankeyPanelHeader title={title} subtitle={subtitle} total={total} />
      </div>
      <SankeyChart
        nodes={nodes}
        links={links}
        columnLabels={columnLabels}
        accent={accent}
      />
      <div className="grid grid-cols-2 gap-3 p-4 pt-3 border-t border-line">
        <SankeyStatBox
          value={`${pct(footer.monologos, total)}%`}
          label="monólogos del banco"
        />
        <SankeyStatBox
          value={`${pct(footer.sinDesenlace, total)}%`}
          label="sin desenlace observable"
        />
        <SankeyStatBox
          value={`${pct(footer.colocacion, total)}%`}
          label="colocación verificada"
          highlight
        />
        <SankeyStatBox
          value={fmt(footer.entregaron)}
          label="entregaron docs sin respuesta"
        />
      </div>
    </div>
  );
}

function SankeyPanelHeader({ title, subtitle, total }) {
  return (
    <div className="mb-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="text-xs font-semibold tabular-nums text-ink-muted">{fmt(total)} hilos</p>
      </div>
      <p className="text-[11px] text-ink-muted mt-0.5">{subtitle}</p>
    </div>
  );
}

function SankeyStatBox({ value, label, highlight }) {
  return (
    <div>
      <p className={`text-xl font-bold tabular-nums ${highlight ? 'text-accent' : 'text-ink'}`}>{value}</p>
      <p className="text-[11px] text-ink-muted mt-1 leading-snug">{label}</p>
    </div>
  );
}

/**
 * Color por significado, no por posición: el mismo estado se lee del mismo
 * color en cualquier columna. Verde avanza, naranja queda sin cerrar, rojo se
 * pierde, navy/gris es volumen sin señal.
 */
function sankeyNodeColor(label = '', col = 0, accent = '') {
  const l = label.toLowerCase();
  if (col === 0) {
    if (l.includes('inbound') || accent === 'inbound') return '#0F172A';
    if (l.includes('outbound') || accent === 'outbound') return '#64748B';
    if (l.includes('frío') || l.includes('continuación')) return '#2544B8';
    if (l.includes('persecución') || l.includes('demanda')) return '#475569';
    if (l.includes('campaña') || l.includes('marketing')) return '#94A3B8';
    if (l.includes('vacío') || l.includes('adjunto')) return '#CBD5E1';
    if (l.includes('nunca respondió')) return '#F97316';
    return '#94A3B8';
  }
  if (col === 1) {
    if (l.includes('unilateral') || l.includes('sin gestión')) return '#1E293B';
    if (l.includes('neta')) return '#2544B8';
    if (l.includes('activo') || l.includes('comercial')) return '#10B981';
    if (l.includes('apag') || l.includes('tibio') || l.includes('murió')) return '#DC2626';
    return '#94A3B8';
  }
  if (l.includes('sin desenlace') || l.includes('sin dato') || l.includes('sin clasificar')) return '#F97316';
  if (l.includes('colocación') || l.includes('verificada') || l.includes('señal de avance')) return '#10B981';
  if (l.includes('rechaz')) return '#DC2626';
  if (l.includes('declina') || l.includes('otro canal')) return '#F59E0B';
  return '#94A3B8';
}

// SVG Sankey personalizado (sin dependencias npm)
function SankeyChart({
  nodes,
  links,
  columnLabels = ['Origen del contacto', 'Qué pasó en la conversación', 'Desenlace'],
  compact = false,
  accent = '',
}) {
  const WIDTH = compact ? 580 : 1240;
  const HEIGHT = compact ? 340 : 400;
  const NODE_WIDTH = compact ? 14 : 18;
  const COL_X = compact ? [100, 270, 440] : [170, 560, 850];
  const PADDING = compact ? 10 : 14;
  const TOP = compact ? 26 : 30;
  const labelSize = compact ? 10 : 11;
  const headerSize = compact ? 8 : 9;

  const byCol = [0, 1, 2].map(col => nodes.filter(n => n.col === col));

  // Escala compartida: la altura total disponible se reparte entre el volumen
  // de la columna más cargada, así las tres columnas quedan comparables.
  const colTotals = byCol.map(colNodes => colNodes.reduce((s, n) => s + n.value, 0));
  const maxColTotal = Math.max(1, ...colTotals);

  const nodePos = new Map();
  byCol.forEach((colNodes, col) => {
    const gaps = PADDING * Math.max(0, colNodes.length - 1);
    const usableH = HEIGHT - gaps;
    const scale = usableH / maxColTotal;
    const heights = colNodes.map(n => Math.max(6, n.value * scale));
    const totalUsed = heights.reduce((a, b) => a + b, 0) + gaps;
    let y = Math.max(0, (HEIGHT - totalUsed) / 2);
    colNodes.forEach((node, i) => {
      nodePos.set(node.id, {
        ...node,
        x: COL_X[col],
        y,
        h: heights[i],
        color: sankeyNodeColor(node.label, col, accent),
      });
      y += heights[i] + PADDING;
    });
  });

  // Offsets acumulados por nodo para apilar los links sin solaparse
  const srcOffsets = new Map();
  const tgtOffsets = new Map();

  const paths = links.map((link, i) => {
    const src = nodePos.get(link.source);
    const tgt = nodePos.get(link.target);
    if (!src || !tgt) return null;

    const srcH = (link.value / Math.max(1, src.value)) * src.h;
    const tgtH = (link.value / Math.max(1, tgt.value)) * tgt.h;

    const so = srcOffsets.get(link.source) || 0;
    const to = tgtOffsets.get(link.target) || 0;
    srcOffsets.set(link.source, so + srcH);
    tgtOffsets.set(link.target, to + tgtH);

    const x1 = src.x + NODE_WIDTH;
    const y1 = src.y + so;
    const x2 = tgt.x;
    const y2 = tgt.y + to;
    const cx = (x1 + x2) / 2;

    const d = [
      `M${x1},${y1}`,
      `C${cx},${y1} ${cx},${y2} ${x2},${y2}`,
      `L${x2},${y2 + tgtH}`,
      `C${cx},${y2 + tgtH} ${cx},${y1 + srcH} ${x1},${y1 + srcH}`,
      'Z',
    ].join(' ');

    return { key: `${link.source}->${link.target}-${i}`, d, color: tgt.color, link };
  }).filter(Boolean);

  const COL_LABELS = columnLabels;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT + TOP + 16}`}
        className="w-full"
        style={{ minWidth: compact ? 420 : 860 }}
      >
        {COL_X.map((x, i) => (
          <text
            key={i}
            x={i === 0 ? x + NODE_WIDTH : x}
            y={14}
            textAnchor={i === 0 ? 'end' : 'start'}
            fontSize={headerSize}
            fill="#94A3B8"
            fontWeight={700}
            letterSpacing="0.06em"
          >
            {COL_LABELS[i]?.toUpperCase() || ''}
          </text>
        ))}

        <g transform={`translate(0,${TOP})`}>
          {paths.map(({ key, d, color, link }) => (
            <path key={key} d={d} fill={color} fillOpacity={0.28} stroke="none">
              <title>
                {link.source.split(':')[1]} → {link.target.split(':')[1]}: {fmt(link.value)}
              </title>
            </path>
          ))}

          {[...nodePos.values()].map(pos => {
            const labelLeft = pos.col === 0;
            const displayLabel = shortFlowLabel(pos.label);
            return (
              <g key={pos.id}>
                <title>{pos.label} · {fmt(pos.value)}</title>
                <rect
                  x={pos.x}
                  y={pos.y}
                  width={NODE_WIDTH}
                  height={pos.h}
                  rx={3}
                  fill={pos.color}
                />
                <text
                  x={labelLeft ? pos.x - 8 : pos.x + NODE_WIDTH + 8}
                  y={pos.y + pos.h / 2 + 4}
                  textAnchor={labelLeft ? 'end' : 'start'}
                  fontSize={labelSize}
                  fill="#1E293B"
                  fontWeight={600}
                >
                  {displayLabel} · {fmt(pos.value)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ─── WhoIsWaiting ─────────────────────────────────────────────────────────────

function CompositionPanel({ stats, selectedStage }) {
  const { esperandoBanco, silencioLargo, sentimientoNegativo, emailsSinRespuesta } = stats;
  return (
    <div className="bg-surface border border-line rounded-panel shadow-panel p-5">
      <div className="mb-4">
        <p className="text-sm font-semibold text-ink">Composición de la conversación</p>
        {selectedStage && (
          <p className="text-[11px] text-ink-muted mt-0.5">filtrado · {selectedStage}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-5">
        <StatTile
          value={fmt(esperandoBanco)}
          label="hilos cuyo último mensaje lo escribió el cliente: el banco aún no respondió."
          highlight
        />
        <StatTile
          value={fmt(silencioLargo)}
          label="hilos con más de 30 días de silencio entre dos mensajes."
        />
        <StatTile
          value={fmt(sentimientoNegativo)}
          label="hilos con sentimiento negativo."
        />
        <StatTile
          value={fmt(emailsSinRespuesta)}
          label="correos del banco que el cliente nunca respondió."
        />
      </div>
    </div>
  );
}

function StatTile({ value, label, highlight }) {
  return (
    <div>
      <p className={`text-3xl font-bold tabular-nums ${highlight ? 'text-accent' : 'text-ink'}`}>{value}</p>
      <p className="text-[11px] text-ink-muted mt-1 leading-snug">{label}</p>
    </div>
  );
}

// ─── ThreadLengthPanel ────────────────────────────────────────────────────────

function ThreadLengthPanel({ distribution, selectedStage }) {
  const max = Math.max(1, ...distribution.map(b => b.n));
  const totalThreads = distribution.reduce((s, b) => s + b.n, 0);
  const monologo = distribution.filter(b => b.max <= 2).reduce((s, b) => s + b.n, 0);

  return (
    <div className="bg-surface border border-line rounded-panel shadow-panel p-4">
      <div className="mb-3">
        <p className="text-sm font-semibold text-ink">Largo del hilo</p>
        {selectedStage && (
          <p className="text-[11px] text-ink-muted mt-0.5">filtrado · {selectedStage}</p>
        )}
      </div>
      <div className="space-y-2">
        {distribution.map(bucket => (
          <div key={bucket.label} className="grid grid-cols-[130px_1fr_50px] gap-3 items-center">
            <span className="text-xs text-ink">{bucket.label}</span>
            <span className="h-3 rounded-full bg-line/30 overflow-hidden">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.max(2, Math.round((bucket.n / max) * 100))}%` }}
              />
            </span>
            <span className="text-xs font-semibold tabular-nums text-ink text-right">{fmt(bucket.n)}</span>
          </div>
        ))}
      </div>
      {totalThreads > 0 && (
        <p className="mt-4 text-[11px] text-ink-muted leading-snug">
          {pct(monologo, totalThreads)}% de los hilos tiene uno o dos mensajes. El canal casi nunca resuelve: notifica.
        </p>
      )}
    </div>
  );
}

// ─── TopicsByStagePanel ───────────────────────────────────────────────────────

function TopicsByStagePanel({ topics, selectedStage, onClearStage }) {
  const maxN = topics[0]?.n || 1;
  return (
    <div className="bg-surface border border-line rounded-panel shadow-panel p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">Temas por etapa</p>
          <p className="text-[11px] text-ink-muted mt-0.5">
            {selectedStage
              ? `top temas en ${selectedStage}`
              : 'click en una etapa del embudo para filtrar · vista global'}
          </p>
        </div>
        {selectedStage && (
          <button
            type="button"
            onClick={onClearStage}
            className="text-xs font-semibold text-navy hover:underline"
          >
            ver global
          </button>
        )}
      </div>
      {topics.length > 0 ? (
        <div className="space-y-2.5">
          {topics.map(({ topic, n }) => (
            <div key={topic} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-0.5">
                <p className="text-xs text-ink truncate" title={topic}>{topic}</p>
                <span className="text-xs font-semibold tabular-nums text-ink shrink-0">{fmt(n)}</span>
              </div>
              <span className="block h-2 rounded-full bg-line/30 overflow-hidden">
                <span
                  className="block h-full rounded-full bg-navy"
                  style={{ width: `${Math.max(2, Math.round((n / maxN) * 100))}%` }}
                />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">Sin temas detectados{selectedStage ? ` para ${selectedStage}` : ''}.</p>
      )}
    </div>
  );
}
