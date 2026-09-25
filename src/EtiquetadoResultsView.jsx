import { useState, useMemo } from 'react';
import ExcelJS from 'exceljs';

// ── Paleta de colores ─────────────────────────────────────────────────────────
const COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6',
  '#f43f5e', '#3b82f6', '#a855f7', '#22d3ee', '#fb923c',
  '#64748b', '#d946ef', '#0ea5e9', '#16a34a', '#dc2626',
];
const SPECIAL_COLORS = { WMI000: '#94a3b8', WMD000: '#fb923c', WMA000: '#64748b' };
const OTHERS_CODES = new Set(['WMA000', 'WMA010']);

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseAssigned(value) {
  if (!value) return [];
  return value.split(';').map(s => s.trim()).filter(Boolean);
}

function splitCodeName(entry) {
  const idx = entry.indexOf(' - ');
  if (idx === -1) return { code: entry, name: entry };
  return { code: entry.slice(0, idx).trim(), name: entry.slice(idx + 3).trim() };
}

function buildStats(results) {
  const map = {};
  results.forEach(row => {
    parseAssigned(row.CategoriaAsignada).forEach(cat => {
      if (cat === 'ERROR') return;
      map[cat] = (map[cat] || 0) + 1;
    });
  });
  let colorIdx = 0;
  return Object.entries(map)
    .map(([entry, count]) => {
      const { code, name } = splitCodeName(entry);
      const color = SPECIAL_COLORS[code] ?? COLORS[colorIdx++ % COLORS.length];
      return { entry, code, label: name, count, color };
    })
    .sort((a, b) => b.count - a.count);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resalta dentro de un texto los fragmentos exactos de evidence (primera aparición).
function highlightEvidence(text, fragments) {
  const str = String(text ?? '');
  if (!fragments?.length) return [{ text: str, highlight: false }];
  const uniq = [...new Set(fragments.map(f => String(f || '').trim()).filter(Boolean))];
  if (!uniq.length) return [{ text: str, highlight: false }];

  const pattern = new RegExp(`(${uniq.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|')})`, 'gi');
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = pattern.exec(str)) !== null) {
    if (m.index > lastIndex) parts.push({ text: str.slice(lastIndex, m.index), highlight: false });
    parts.push({ text: m[0], highlight: true });
    lastIndex = m.index + m[0].length;
    if (m.index === pattern.lastIndex) pattern.lastIndex++; // previene loop con regex vacía
  }
  if (lastIndex < str.length) parts.push({ text: str.slice(lastIndex), highlight: false });
  return parts;
}

function confidenceColor(conf) {
  const c = Math.max(0, Math.min(1, Number(conf) || 0));
  if (c >= 0.85) return '#10b981'; // verde
  if (c >= 0.6)  return '#f59e0b'; // ámbar
  if (c > 0)     return '#ef4444'; // rojo
  return '#9ca3af';                 // gris (sin valor)
}

// ── Tabla de frecuencias ──────────────────────────────────────────────────────
const PAGE_SIZE = 50;

function FrequencyTable({ stats, total }) {
  const [filter,  setFilter]  = useState('');
  const [sortKey, setSortKey] = useState('count');
  const [sortAsc, setSortAsc] = useState(false);

  const toggleSort = (key) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(key === 'code'); }
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = q
      ? stats.filter(s => s.code.toLowerCase().includes(q) || s.label.toLowerCase().includes(q))
      : stats;
    return [...base].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'number') return sortAsc ? va - vb : vb - va;
      return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }, [stats, filter, sortKey, sortAsc]);

  const maxCount = Math.max(...filtered.map(r => r.count), 1);

  const SortIcon = ({ k }) => (
    <span className="ml-1 text-[10px]">{sortKey === k ? (sortAsc ? '▲' : '▼') : '⇅'}</span>
  );
  const hCls = (k) =>
    `px-3 py-2 text-left text-xs font-semibold cursor-pointer hover:text-gray-700 select-none ${sortKey === k ? 'text-gray-700' : 'text-gray-500'}`;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 px-5">
        <input
          type="text"
          placeholder="Buscar código o categoría…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400"
        />
        <span className="text-xs text-gray-400 shrink-0">{filtered.length} de {stats.length}</span>
      </div>
      <div className="overflow-auto border-t border-gray-100" style={{ maxHeight: 'calc(100vh - 260px)', minHeight: 400 }}>
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
            <tr>
              <th className={hCls('code')}    onClick={() => toggleSort('code')}>Código <SortIcon k="code" /></th>
              <th className={hCls('label')}   onClick={() => toggleSort('label')}>Categoría <SortIcon k="label" /></th>
              <th className={hCls('count')}   onClick={() => toggleSort('count')}>Frecuencia <SortIcon k="count" /></th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">% del Total</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, i) => {
              const pct = total > 0 ? ((row.count / total) * 100).toFixed(2) : '0.00';
              return (
                <tr key={row.code + i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                  <td className="px-3 py-2 font-mono text-xs text-gray-400 whitespace-nowrap">{row.code}</td>
                  <td className="px-3 py-2 text-gray-800">{row.label}</td>
                  <td className="px-3 py-2 font-semibold tabular-nums text-gray-700">{row.count.toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="w-16 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(row.count / maxCount) * 100}%`, backgroundColor: row.color }} />
                      </div>
                      <span className="tabular-nums text-xs text-gray-600">{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tabla de datos editables ──────────────────────────────────────────────────
function DataTable({ editedResults, setEditedResults, textColumn, knownOptions }) {
  const [page,   setPage]   = useState(0);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? editedResults.filter(r =>
          (r[textColumn] || '').toLowerCase().includes(q) ||
          (r.CategoriaAsignada || '').toLowerCase().includes(q)
        )
      : editedResults;
  }, [editedResults, filter, textColumn]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows   = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const realIndex = (row) => editedResults.indexOf(row);

  function updateCat(realIdx, newVal) {
    setEditedResults(prev => prev.map((r, i) => i === realIdx ? { ...r, CategoriaAsignada: newVal } : r));
  }

  const handlePageChange = (newPage) => {
    setPage(Math.max(0, Math.min(newPage, totalPages - 1)));
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap px-5">
        <input
          type="text"
          placeholder="Buscar en texto o categoría asignada…"
          value={filter}
          onChange={e => { setFilter(e.target.value); setPage(0); }}
          className="flex-1 min-w-48 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400"
        />
        <span className="text-xs text-gray-400 shrink-0">{filtered.length} registros</span>
      </div>

      <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3 mx-5">
        ✏ Haz clic en <strong>Categoría asignada</strong> para corregir la clasificación de cualquier registro.
      </p>

      <div className="overflow-auto border-t border-gray-100" style={{ maxHeight: 580 }}>
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-3 py-2 text-xs font-semibold text-gray-400 text-right w-10">#</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Texto</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 w-64">Categoría asignada</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => {
              const ri = realIndex(row);
              const text = String(row[textColumn] || '');
              return (
                <tr key={ri} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                  <td className="px-3 py-2 text-xs text-gray-300 text-right tabular-nums">{page * PAGE_SIZE + i + 1}</td>
                  <td className="px-3 py-2 text-gray-700 text-xs leading-relaxed max-w-md">
                    <span title={text}>{text.length > 140 ? text.slice(0, 140) + '…' : text}</span>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      value={row.CategoriaAsignada || ''}
                      onChange={e => updateCat(ri, e.target.value)}
                      className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:border-blue-400 bg-white"
                    >
                      {knownOptions.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                      {!knownOptions.includes(row.CategoriaAsignada) && row.CategoriaAsignada && (
                        <option value={row.CategoriaAsignada}>{row.CategoriaAsignada}</option>
                      )}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 px-5">
          <button
            onClick={() => handlePageChange(page - 1)}
            disabled={page === 0}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← Anterior
          </button>
          <span className="text-xs text-gray-500">
            Página {page + 1} de {totalPages} · {filtered.length} registros
          </span>
          <button
            onClick={() => handlePageChange(page + 1)}
            disabled={page >= totalPages - 1}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Siguiente →
          </button>
        </div>
      )}
    </div>
  );
}

// ── NUEVO: Vista QA con justificación, evidencia y sugerencias expertas ──────
function QAView({ editedResults, textColumn, taggingMode }) {
  const showConfidence = taggingMode !== 'single';

  const [filter,     setFilter]     = useState('');
  // 'none' | 'high' (>=0.85) | 'low' (<0.85)
  const [confFilter, setConfFilter] = useState(() => showConfidence ? 'low' : 'none');
  const [onlyOthers, setOnlyOthers] = useState(false);
  // Sort: 'id' | 'Confianza', plus direction
  const [sortKey, setSortKey] = useState(() => showConfidence ? 'Confianza' : 'id');
  const [sortAsc, setSortAsc] = useState(true);

  // ID original de cada fila (#1, #2, …) incluso tras filtrar/ordenar
  const rowIdMap = useMemo(() => {
    const m = new Map();
    editedResults.forEach((r, i) => m.set(r, i + 1));
    return m;
  }, [editedResults]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let base = editedResults;
    if (q) {
      base = base.filter(r =>
        (r[textColumn] || '').toLowerCase().includes(q) ||
        (r.CategoriaAsignada || '').toLowerCase().includes(q) ||
        (r.Justificacion || '').toLowerCase().includes(q)
      );
    }
    if (confFilter === 'high') base = base.filter(r => Number(r.Confianza) >= 0.85);
    if (confFilter === 'low')  base = base.filter(r => Number(r.Confianza) < 0.85);
    if (onlyOthers) {
      base = base.filter(r => {
        const primary = (r.CategoriaAsignada || '').split(';')[0].trim().split(' - ')[0];
        return OTHERS_CODES.has(primary) || !r.CategoriaAsignada;
      });
    }
    return [...base].sort((a, b) => {
      if (sortKey === 'id') {
        const ia = rowIdMap.get(a) ?? 0;
        const ib = rowIdMap.get(b) ?? 0;
        return sortAsc ? ia - ib : ib - ia;
      }
      const va = Number(a[sortKey] ?? 0);
      const vb = Number(b[sortKey] ?? 0);
      return sortAsc ? va - vb : vb - va;
    });
  }, [editedResults, filter, confFilter, onlyOthers, sortKey, sortAsc, textColumn, rowIdMap]);

  // Opciones de orden según modo
  const sortOptions = showConfidence
    ? [
        { value: 'Confianza-asc',  label: 'Confianza (asc)' },
        { value: 'Confianza-desc', label: 'Confianza (desc)' },
        { value: 'id-asc',         label: 'ID (asc)' },
        { value: 'id-desc',        label: 'ID (desc)' },
      ]
    : [
        { value: 'id-asc',  label: 'ID (asc)' },
        { value: 'id-desc', label: 'ID (desc)' },
      ];

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap px-5 pt-3">
        <input
          type="text"
          placeholder="Buscar en texto, categoría o justificación…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 min-w-48 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400"
        />
        {showConfidence && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={confFilter === 'high'}
                onChange={e => setConfFilter(e.target.checked ? 'high' : 'none')}
              />
              Confianza &ge; 85%
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={confFilter === 'low'}
                onChange={e => setConfFilter(e.target.checked ? 'low' : 'none')}
              />
              Confianza &lt; 85%
            </label>
          </>
        )}
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input type="checkbox" checked={onlyOthers} onChange={e => setOnlyOthers(e.target.checked)} />
          Solo "Otros"
        </label>
        <div className="flex items-center gap-1 text-xs text-gray-500">
          Orden:
          <select
            value={`${sortKey}-${sortAsc ? 'asc' : 'desc'}`}
            onChange={e => {
              const parts = e.target.value.split('-');
              const dir   = parts.pop();
              setSortKey(parts.join('-'));
              setSortAsc(dir === 'asc');
            }}
            className="border border-gray-200 rounded px-1.5 py-0.5"
          >
            {sortOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <span className="text-xs text-gray-400 shrink-0">{rows.length} registros</span>
      </div>

      <p className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2 mb-3 mx-5">
        🔎 Cada tarjeta muestra el texto con la <strong>evidencia resaltada</strong> y la <strong>justificación</strong> del modelo.
        Para los casos "Otros", verás sugerencias del <strong>catálogo experto</strong> para iterar la taxonomía.
      </p>

      <div className="overflow-auto border-t border-gray-100 px-5 py-3 space-y-3" style={{ maxHeight: 'calc(100vh - 260px)', minHeight: 400 }}>
        {rows.map((row, i) => {
          const text = String(row[textColumn] || '');
          const assignments = Array.isArray(row._assignments) ? row._assignments : [];
          const suggestions = Array.isArray(row._suggestions) ? row._suggestions : [];
          const allEvidence = assignments.flatMap(a => a.evidence || []);
          const parts = highlightEvidence(text, allEvidence);
          const conf = Number(row.Confianza) || 0;
          const confPct = Math.round(conf * 100);
          const isOthers = (() => {
            const primary = (row.CategoriaAsignada || '').split(';')[0].trim().split(' - ')[0];
            return OTHERS_CODES.has(primary) || !row.CategoriaAsignada;
          })();

          const rowId = rowIdMap.get(row);
          return (
            <div key={i} className="border border-gray-200 rounded-xl p-4 hover:border-gray-300 transition-colors">
              {/* Fila de ID + categorías + confianza (multi-tag) */}
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex items-center flex-wrap gap-1.5">
                  <span className="font-mono text-[11px] text-gray-400 shrink-0 mr-0.5">#{rowId}</span>
                  {(row.CategoriaAsignada ? row.CategoriaAsignada.split(';').map(s => s.trim()) : ['WMA000 - Otros']).map((entry, idx) => {
                    const { code } = splitCodeName(entry);
                    const color = SPECIAL_COLORS[code] ?? COLORS[idx % COLORS.length];
                    return (
                      <span key={entry + idx} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: `${color}1a`, color }}>
                        <span className="font-mono text-[10px]">{code}</span>
                        <span>{splitCodeName(entry).name}</span>
                      </span>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {showConfidence && (
                    <div className="flex items-center gap-1.5" title={`Confianza: ${confPct}%`}>
                      <div className="w-20 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.max(confPct, 2)}%`, backgroundColor: confidenceColor(conf) }} />
                      </div>
                      <span className="tabular-nums text-xs font-semibold" style={{ color: confidenceColor(conf) }}>{confPct}%</span>
                    </div>
                  )}
                  {Number(row.TokensConsumidos) > 0 && (
                    <span className="text-[10px] text-sky-500 font-mono tabular-nums" title="Tokens consumidos por esta clasificación">
                      {Number(row.TokensConsumidos).toLocaleString()} tk
                    </span>
                  )}
                </div>
              </div>

              <div className="text-sm text-gray-700 leading-relaxed mb-3 whitespace-pre-wrap">
                {parts.map((p, idx) => p.highlight
                  ? <mark key={idx} className="bg-yellow-200/80 rounded px-0.5">{p.text}</mark>
                  : <span key={idx}>{p.text}</span>
                )}
              </div>

              {assignments.length > 0 && assignments.some(a => a.justification) && (
                <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 text-xs space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">Justificación del modelo</p>
                  {assignments.map((a, idx) => (
                    <div key={idx} className="text-gray-700">
                      <span className="font-mono text-gray-400">{a.code}</span>{' '}
                      {a.justification || <span className="text-gray-400 italic">Sin justificación</span>}
                    </div>
                  ))}
                </div>
              )}

              {isOthers && suggestions.length > 0 && (
                <div className="mt-3 bg-indigo-50 border border-indigo-100 rounded-lg p-3 text-xs">
                  <p className="text-[10px] uppercase tracking-wide font-semibold text-indigo-700 mb-2">
                    📚 Sugerencias del catálogo experto
                  </p>
                  <ul className="space-y-1.5">
                    {suggestions.map((s, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="shrink-0 text-[10px] font-mono text-indigo-500 mt-0.5">
                          {Math.round((s.matchStrength ?? 0) * 100)}%
                        </span>
                        <div className="flex-1">
                          <p className="font-medium text-indigo-900">{s.catalogPath}</p>
                          {s.rationale && <p className="text-indigo-700/80 mt-0.5">{s.rationale}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="text-center text-sm text-gray-400 py-10">
            No hay registros que coincidan con el filtro.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Panel combinado: sub-tabs Tabla / QA ─────────────────────────────────────
function DatosPanel({ editedResults, setEditedResults, textColumn, knownOptions, taggingMode }) {
  const [subTab, setSubTab] = useState('tabla');

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex gap-1 border-b border-gray-100 px-5 pt-3 pb-0">
        {[
          { id: 'tabla', label: '✏ Tabla' },
          { id: 'qa',    label: '🔎 QA' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors mr-0.5 ${
              subTab === t.id
                ? 'bg-white border border-b-0 border-gray-200 text-[#171433]'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'tabla' && (
        <DataTable
          editedResults={editedResults}
          setEditedResults={setEditedResults}
          textColumn={textColumn}
          knownOptions={knownOptions}
        />
      )}
      {subTab === 'qa' && (
        <QAView
          editedResults={editedResults}
          textColumn={textColumn}
          taggingMode={taggingMode}
        />
      )}
    </div>
  );
}

// ── Vista principal ───────────────────────────────────────────────────────────
export default function EtiquetadoResultsView({ results, taggingMode, textColumn, metadata = null }) {
  const [tab,           setTab]           = useState('resumen');
  const [editedResults, setEditedResults] = useState(() => results.map(r => ({ ...r })));
  const [isExporting,   setIsExporting]   = useState(false);

  const stats = useMemo(() => buildStats(editedResults), [editedResults]);
  const total  = editedResults.length;

  const uniqueCats   = stats.filter(s => !['WMI000','WMD000','WMA000'].includes(s.code)).length;
  const ignoredCount = stats.find(s => s.code === 'WMI000')?.count ?? 0;
  const derivedCount = stats.find(s => s.code === 'WMD000')?.count ?? 0;

  const avgConfidence = useMemo(() => {
    const values = editedResults.map(r => Number(r.Confianza) || 0).filter(v => v > 0);
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }, [editedResults]);

  const totalTokens = useMemo(
    () => editedResults.reduce((sum, r) => sum + (Number(r.TokensConsumidos) || 0), 0),
    [editedResults]
  );

  const lowConfCount = useMemo(
    () => editedResults.filter(r => Number(r.Confianza) > 0 && Number(r.Confianza) < 0.85).length,
    [editedResults]
  );
  const technicalErrorCount = useMemo(
    () => editedResults.filter(row => row.EstadoEtiquetado === 'technical_error').length,
    [editedResults],
  );
  const emptyCount = useMemo(
    () => editedResults.filter(row => row.EstadoEtiquetado === 'empty').length,
    [editedResults],
  );
  const masterWarningCount = useMemo(
    () => editedResults.filter(row => row.AdvertenciaMaestro).length,
    [editedResults],
  );

  const knownOptions = useMemo(() => {
    const opts = new Set();
    results.forEach(r => parseAssigned(r.CategoriaAsignada).forEach(c => opts.add(c)));
    return [...opts].sort();
  }, [results]);

  const hasEdits = useMemo(() =>
    editedResults.some((r, i) => r.CategoriaAsignada !== results[i]?.CategoriaAsignada),
    [editedResults, results]
  );

  async function exportExcel() {
    setIsExporting(true);
    try {
      const wb = new ExcelJS.Workbook();

      // Columnas para la hoja de datos: excluimos las internas "_assignments"/"_suggestions".
      const EXCLUDE = new Set(['_assignments', '_suggestions', '_empty', '_error']);
      const ws1 = wb.addWorksheet('Datos etiquetados');
      if (editedResults.length > 0) {
        const headers = Object.keys(editedResults[0]).filter(h => !EXCLUDE.has(h));
        ws1.addRow(headers).font = { bold: true };
        editedResults.forEach(row => ws1.addRow(headers.map(h => row[h] ?? '')));
        ws1.columns.forEach(col => { col.width = Math.min(60, Math.max(12, col.width || 15)); });
      }

      const ws2 = wb.addWorksheet('Resumen');
      ws2.addRow(['Código', 'Categoría', 'Frecuencia', '% del Total']).font = { bold: true };
      stats.forEach(s => {
        const pct = total > 0 ? ((s.count / total) * 100).toFixed(2) + '%' : '0.00%';
        ws2.addRow([s.code, s.label, s.count, pct]);
      });
      ws2.columns = [{ width: 12 }, { width: 40 }, { width: 14 }, { width: 14 }];

      // Hoja QA: vista lista para iterar con justificaciones y evidencias.
      const ws3 = wb.addWorksheet('QA');
      ws3.addRow([
        '#', 'Índice original', 'Texto', 'Categoría asignada', 'Fuente', 'Estado', 'Advertencia maestro',
        'Confianza', 'Tokens', 'Justificación', 'Evidencia', 'Sugerencias expertas',
      ]).font = { bold: true };
      editedResults.forEach((row, idx) => {
        ws3.addRow([
          idx + 1,
          row.MuestraIndiceOriginal ?? '',
          row[textColumn] ?? '',
          row.CategoriaAsignada ?? '',
          row.FuenteEtiquetado ?? metadata?.source ?? '',
          row.EstadoEtiquetado ?? '',
          row.AdvertenciaMaestro ?? '',
          Number(row.Confianza) || 0,
          Number(row.TokensConsumidos) || 0,
          row.Justificacion ?? '',
          row.Evidencia ?? '',
          row.SugerenciasExpertas ?? '',
        ]);
      });
      ws3.columns = [
        { width: 6 }, { width: 14 }, { width: 60 }, { width: 32 }, { width: 18 },
        { width: 18 }, { width: 48 }, { width: 12 }, { width: 10 }, { width: 48 }, { width: 40 }, { width: 60 },
      ];
      ws3.getColumn(8).numFmt = '0.00';
      ws3.getColumn(9).numFmt = '0';

      const buffer = await wb.xlsx.writeBuffer();
      const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url    = URL.createObjectURL(blob);
      const a      = document.createElement('a');
      a.href = url;
      a.download = `etiquetado-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  }

  const tabs = [
    { id: 'resumen', label: '📋 Resumen' },
    { id: 'datos',   label: `📂 Datos${hasEdits ? ' ●' : ''}` },
  ];
  const showConfidenceStats = taggingMode !== 'single';

  const StatBadge = ({ label, value, color, suffix = '' }) => (
    <div className="flex flex-col items-center px-4 py-2 rounded-lg bg-white border border-gray-100 shadow-sm min-w-[90px]">
      <span className="text-lg font-bold tabular-nums" style={{ color }}>{typeof value === 'number' ? value.toLocaleString() : value}{suffix}</span>
      <span className="text-[10px] text-gray-400 mt-0.5 text-center leading-tight">{label}</span>
    </div>
  );

  return (
    <div className="mt-6 bg-white rounded-xl shadow-md border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-slate-50 to-white">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-[#171433]">Resultados del etiquetado</h3>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-amber-50 text-amber-700 border border-amber-200">
                Beta
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-0.5">
              Modo: <span className="font-medium text-gray-700">{taggingMode === 'single' ? 'Single-tag' : 'Multi-tag'}</span>
              {metadata?.source && (
                <>
                  {' · '}Fuente: <span className="font-medium text-gray-700">{metadata.source}</span>
                </>
              )}
            </p>
            {metadata?.source === 'multitag-api' && (
              <p className="text-xs text-sky-700 mt-1">
                Cliente {metadata.client} · endpoint {metadata.endpoint} · muestra {metadata.sampleRows} de {metadata.datasetRows}
                {' · '}{metadata.estimatedCalls} llamadas productivas
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <StatBadge label="registros"  value={total}        color="#6366f1" />
              <StatBadge label="categorías" value={uniqueCats}   color="#10b981" />
              {showConfidenceStats && avgConfidence !== null && (
                <StatBadge label="confianza media" value={Math.round(avgConfidence * 100)} color="#8b5cf6" suffix="%" />
              )}
              {showConfidenceStats && lowConfCount > 0 && (
                <StatBadge label="a revisar (<85%)" value={lowConfCount} color="#ef4444" />
              )}
              {ignoredCount > 0 && <StatBadge label="ignorados" value={ignoredCount} color="#94a3b8" />}
              {derivedCount > 0 && <StatBadge label="derivados" value={derivedCount} color="#fb923c" />}
              {emptyCount > 0 && <StatBadge label="vacíos" value={emptyCount} color="#64748b" />}
              {technicalErrorCount > 0 && <StatBadge label="errores técnicos" value={technicalErrorCount} color="#ef4444" />}
              {masterWarningCount > 0 && <StatBadge label="desajustes maestro" value={masterWarningCount} color="#f59e0b" />}
              {totalTokens > 0 && <StatBadge label="tokens totales" value={totalTokens.toLocaleString()} color="#0ea5e9" />}
            </div>
            <button
              onClick={exportExcel}
              disabled={isExporting}
              className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                hasEdits
                  ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              } disabled:opacity-50`}
            >
              {isExporting ? '⏳ Exportando…' : `⬇ Exportar Excel${hasEdits ? ' (con ediciones)' : ''}`}
            </button>
          </div>
        </div>
      </div>

      <div className="flex border-b border-gray-100 px-4 pt-2">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors mr-1 ${
              tab === t.id
                ? 'bg-white border border-b-0 border-gray-200 text-[#171433]'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={tab === 'resumen' ? 'p-5' : 'py-0 px-0'}>
        {tab === 'resumen' && <FrequencyTable stats={stats} total={total} />}
        {tab === 'datos' && (
          <DatosPanel
            editedResults={editedResults}
            setEditedResults={setEditedResults}
            textColumn={textColumn || Object.keys(results[0] || {}).find(k => k !== 'CategoriaAsignada') || ''}
            knownOptions={knownOptions}
            taggingMode={taggingMode}
          />
        )}
      </div>
    </div>
  );
}
