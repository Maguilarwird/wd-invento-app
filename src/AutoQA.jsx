import React, { useMemo, useState, useEffect } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import FileDropzone from './ui/FileDropzone';
import { MAX_DATOS_MB, MAX_JSON_MB } from './ui/archivos';
import { API_BASE } from './config';

// ─── Constantes ───────────────────────────────────────────────────────────────
const SPECIAL_OTHER_CODES = new Set(['WMA000', 'WMA010']);

const ACTION_META = {
  'Mantener':             { color: '#10b981', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  'Modificar definición': { color: '#6366f1', bg: 'bg-indigo-50',  text: 'text-indigo-700',  border: 'border-indigo-200' },
  'Crear categoría':      { color: '#f59e0b', bg: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-200' },
  'Reforzar definición':  { color: '#8b5cf6', bg: 'bg-violet-50',  text: 'text-violet-700',  border: 'border-violet-200' },
  'Revisar solape':       { color: '#ef4444', bg: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-200' },
  'Completar referencia': { color: '#94a3b8', bg: 'bg-slate-50',   text: 'text-slate-600',   border: 'border-slate-200' },
};

const ACTION_DESC = {
  'Mantener':             'Categorías que el modelo predice correctamente con alta fiabilidad.',
  'Modificar definición': 'La predicción y la referencia son conceptualmente cercanas; redefinir el límite entre ellas.',
  'Crear categoría':      'Los analistas etiquetaron casos con referencias que no existen en el modelo.',
  'Reforzar definición':  'El modelo derivó a "Otros" pero existía una categoría aplicable; añadir ejemplos.',
  'Revisar solape':       'Confusión entre categorías sin relación evidente; revisar ambigüedad o falta de ejemplos.',
  'Completar referencia': 'Casos sin etiqueta de referencia del analista; pendiente de completar.',
};

// ─── Helpers puros ────────────────────────────────────────────────────────────
function splitCodeName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { code: '', name: '' };
  const first = raw.split(';')[0].trim();
  const match = first.match(/\b(WM[A-Z]?\d{3})\b/i);
  const code = match ? match[1].toUpperCase() : '';
  const name = first.replace(/\bWM[A-Z]?\d{3}\b\s*[-–:]?\s*/i, '').trim();
  return { code, name: name || first };
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(a, b) {
  const ta = new Set(normalizeText(a).split(' ').filter(t => t.length > 3));
  const tb = new Set(normalizeText(b).split(' ').filter(t => t.length > 3));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  ta.forEach(t => { if (tb.has(t)) shared += 1; });
  return shared / Math.min(ta.size, tb.size);
}

function getCategoryLabel(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object')
    return value.nombre || value.name || value.categoria || value.label || value.descripcion || value.description || '';
  return '';
}

function getCategoryDefinition(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object')
    return value.definicion || value.definition || value.descripcion || value.description || value.detalle || '';
  return '';
}

function normalizeModel(modelJson) {
  const categories = {};
  const parents = {};
  function addCategory(code, value, parent = '') {
    if (!/^WM[A-Z]?\d{3}$/i.test(code)) return;
    const c = code.toUpperCase();
    categories[c] = {
      code: c,
      name: getCategoryLabel(value) || c,
      definition: getCategoryDefinition(value) || getCategoryLabel(value) || '',
      parent,
    };
    if (parent) parents[c] = parent;
  }
  if (!modelJson || typeof modelJson !== 'object') return { categories, parents };
  Object.entries(modelJson).forEach(([key, value]) => {
    if (/^WM[A-Z]?\d{3}$/i.test(key)) { addCategory(key, value); return; }
    if (value && typeof value === 'object' && !Array.isArray(value))
      Object.entries(value).forEach(([ck, cv]) => { if (/^WM[A-Z]?\d{3}$/i.test(ck)) addCategory(ck, cv, key); });
  });
  return { categories, parents };
}

function inferColumn(columns, candidates) {
  const normalized = columns.map(c => ({ original: c, norm: normalizeText(c) }));
  for (const candidate of candidates) {
    const target = normalizeText(candidate);
    const exact = normalized.find(c => c.norm === target);
    if (exact) return exact.original;
    const inc = normalized.find(c => c.norm.includes(target));
    if (inc) return inc.original;
  }
  return '';
}

async function readJsonFile(file) {
  return JSON.parse(await file.text());
}

async function readDataFile(file) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'xls') {
    throw new Error('Formato .xls (Excel 97-2003) no soportado. Guarda el archivo como .xlsx e inténtalo de nuevo.');
  }
  if (ext === 'csv') {
    const parsed = Papa.parse(await file.text(), { header: true, skipEmptyLines: true });
    if (parsed.errors?.length) throw new Error(parsed.errors[0].message);
    return parsed.data;
  }
  if (ext !== 'xlsx') throw new Error('Formato de archivo no soportado.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const headers = [];
  sheet.getRow(1).eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? '').trim(); });
  const rows = [];
  sheet.eachRow((row, rn) => {
    if (rn === 1) return;
    const obj = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      const cell = row.getCell(idx + 1).value;
      obj[h] = cell?.text ?? cell?.result ?? cell ?? '';
    });
    if (Object.values(obj).some(v => String(v ?? '').trim())) rows.push(obj);
  });
  return rows;
}

function recommendAction({ predicted, reference, predictedInfo, referenceInfo }) {
  if (!reference.code && !reference.name)
    return { action: 'Completar referencia', reason: 'No hay etiqueta de referencia del analista para validar este caso.' };
  if (predicted.code && reference.code && predicted.code === reference.code)
    return { action: 'Mantener', reason: 'La etiqueta del modelo coincide con la referencia del analista.' };
  if (SPECIAL_OTHER_CODES.has(predicted.code))
    return {
      action: referenceInfo ? 'Reforzar definición' : 'Crear categoría',
      reason: referenceInfo
        ? 'El modelo derivó a Otros, pero la referencia apunta a una categoría existente. Añadir ejemplos a esa categoría.'
        : 'El analista marcó una referencia que no está en el modelo cargado. Considerar crearla.',
    };
  if (reference.code && !referenceInfo)
    return { action: 'Crear categoría', reason: 'La referencia del analista no existe en el modelo; evaluar si conviene agregarla.' };
  const sameParent = predictedInfo?.parent && predictedInfo.parent === referenceInfo?.parent;
  const overlap = tokenOverlap(predictedInfo?.name || predicted.name, referenceInfo?.name || reference.name);
  if (sameParent || overlap >= 0.45)
    return { action: 'Modificar definición', reason: 'Las categorías comparten grupo o términos; redefinir el límite entre ellas con ejemplos concretos.' };
  return { action: 'Revisar solape', reason: 'La predicción y la referencia difieren sin relación clara; revisar si hay ambigüedad en las definiciones.' };
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────
function ActionBadge({ action, size = 'sm' }) {
  const meta = ACTION_META[action] || { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' };
  const sz = size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  return (
    <span className={`inline-flex items-center rounded-full font-medium border ${sz} ${meta.bg} ${meta.text} ${meta.border}`}>
      {action}
    </span>
  );
}

function StatCard({ label, value, tone = 'blue', suffix = '' }) {
  const colors = {
    blue:   'text-blue-700   bg-blue-50   border-blue-100',
    green:  'text-emerald-700 bg-emerald-50 border-emerald-100',
    red:    'text-red-700    bg-red-50    border-red-100',
    amber:  'text-amber-700  bg-amber-50  border-amber-100',
    violet: 'text-violet-700 bg-violet-50 border-violet-100',
    slate:  'text-slate-600  bg-slate-50  border-slate-100',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${colors[tone] || colors.blue}`}>
      <div className="text-2xl font-bold tabular-nums">{value}{suffix}</div>
      <div className="text-xs opacity-70 mt-0.5">{label}</div>
    </div>
  );
}

// ─── Tab: Resumen ─────────────────────────────────────────────────────────────
function TabResumen({ reviewStats, categorySummary, downloadReviewReport }) {
  const actionEntries = Object.entries(reviewStats.actions).sort((a, b) => b[1] - a[1]);
  const maxAction = Math.max(...actionEntries.map(([, v]) => v), 1);

  const [sortKey, setSortKey] = useState('errors');   // 'errors' | 'total' | 'name'
  const [sortDir, setSortDir] = useState('desc');      // 'asc' | 'desc'

  const sortedSummary = useMemo(() => {
    return [...categorySummary].sort((a, b) => {
      let va, vb;
      if (sortKey === 'name')   { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
      else if (sortKey === 'total') { va = a.total; vb = b.total; }
      else                      { va = a.errors; vb = b.errors; }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });
  }, [categorySummary, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };
  const SortBtn = ({ k, label }) => (
    <button
      onClick={() => toggleSort(k)}
      className={`px-2.5 py-1 text-[11px] rounded-md border transition-colors ${
        sortKey === k ? 'bg-[#171433] text-white border-[#171433]' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
      }`}
    >
      {label} {sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </button>
  );

  return (
    <div className="space-y-5 pt-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="casos totales"  value={reviewStats.total}         tone="blue" />
        <StatCard label="con referencia" value={reviewStats.withReference} tone="violet" />
        <StatCard label="correctos"      value={reviewStats.correct}       tone="green" />
        <StatCard label="errores"        value={reviewStats.errors}        tone="red" />
        <StatCard
          label="accuracy"
          value={reviewStats.accuracy === null ? 'N/A' : Math.round(reviewStats.accuracy * 100)}
          suffix={reviewStats.accuracy === null ? '' : '%'}
          tone="amber"
        />
      </div>

      {/* Distribución de acciones — fila completa */}
      <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
        <h3 className="font-semibold text-[#171433] mb-4">Distribución de acciones sugeridas</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-3">
          {actionEntries.map(([action, count]) => {
            const meta = ACTION_META[action] || { color: '#94a3b8' };
            const pct  = Math.round((count / reviewStats.total) * 100);
            const barW = Math.round((count / maxAction) * 100);
            return (
              <div key={action}>
                <div className="flex items-center justify-between mb-1">
                  <ActionBadge action={action} size="xs" />
                  <span className="text-xs tabular-nums text-gray-500">{count} casos · {pct}%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${barW}%`, backgroundColor: meta.color }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Hallazgos por categoría — fila completa */}
      <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="font-semibold text-[#171433]">Hallazgos por categoría</h3>
            <p className="text-xs text-gray-400 mt-0.5">Top 12 · ordenar por:</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex gap-1">
              <SortBtn k="errors" label="Errores" />
              <SortBtn k="total"  label="Frecuencia" />
              <SortBtn k="name"   label="Categoría" />
            </div>
            <button
              onClick={downloadReviewReport}
              className="text-xs px-3 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors"
            >
              Descargar Excel
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 overflow-auto" style={{ maxHeight: 480 }}>
          {sortedSummary.map(item => {
            const errPct = Math.round(item.errorRate * 100);
            const topRef = item.topReference;
            const topAct = item.topAction;
            return (
              <div key={item.code} className="border border-gray-100 rounded-lg px-3 py-2.5">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-[10px] text-gray-400 shrink-0">{item.code}</span>
                    <span className="text-sm text-gray-800 truncate" title={item.name}>{item.name}</span>
                  </div>
                  <span className="text-xs tabular-nums text-gray-500 shrink-0">{item.total} casos</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${errPct}%`, backgroundColor: errPct > 50 ? '#ef4444' : errPct > 25 ? '#f59e0b' : '#10b981' }} />
                    </div>
                    <span className={`text-[11px] tabular-nums font-medium shrink-0 ${errPct > 50 ? 'text-red-600' : errPct > 25 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {errPct}% error
                    </span>
                  </div>
                  {topAct && <ActionBadge action={topAct[0]} size="xs" />}
                </div>
                {topRef && topRef[0] !== item.code && (
                  <p className="text-[10px] text-gray-400 mt-1">
                    Ref. frecuente: <strong className="text-gray-600">{topRef[0]}</strong> · {topRef[1]} de {item.total} casos
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Tab: Casos ───────────────────────────────────────────────────────────────
function TabCasos({ filteredReviewRows, reviewFilter, setReviewFilter, reviewSearch, setReviewSearch }) {
  const [expanded, setExpanded] = useState(null);
  const toggle = (id) => setExpanded(prev => prev === id ? null : id);

  return (
    <div className="pt-4 space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <input
          value={reviewSearch}
          onChange={e => setReviewSearch(e.target.value)}
          placeholder="Buscar texto, categoría o acción..."
          className="flex-1 min-w-52 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
        />
        <div className="flex gap-1 flex-wrap">
          {[['errores','Solo errores'],['todos','Todos'],['correctos','Correctos'],['otros','Otros'],['crear','Crear cat.']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setReviewFilter(val)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                reviewFilter === val ? 'bg-[#171433] text-white border-[#171433]' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400 shrink-0">{filteredReviewRows.length} registros</span>
      </div>

      <div className="space-y-2 overflow-auto" style={{ maxHeight: 'calc(100vh - 320px)', minHeight: 400 }}>
        {filteredReviewRows.map(r => {
          const isOpen = expanded === r.id;
          const meta   = ACTION_META[r.recommendation.action] || {};

          // Sólo mostrar definición si es diferente al nombre (evita duplicados)
          const predDef = r.predictedInfo?.definition;
          const predName = r.predictedInfo?.name || r.predicted.name;
          const showPredDef = predDef && normalizeText(predDef).slice(0, 60) !== normalizeText(predName).slice(0, 60);

          const refDef = r.referenceInfo?.definition;
          const refName = r.referenceInfo?.name || r.reference.name;
          const showRefDef = refDef && normalizeText(refDef).slice(0, 60) !== normalizeText(refName).slice(0, 60);

          return (
            <div key={r.id} className={`border rounded-xl overflow-hidden transition-all ${r.matches ? 'border-gray-200' : 'border-red-100'}`}>
              {/* Fila compacta */}
              <button className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors" onClick={() => toggle(r.id)}>
                <span className="font-mono text-[11px] text-gray-400 shrink-0 w-8">#{r.id}</span>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                    r.matches ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'
                  }`}>
                    <span className="font-mono">{r.predicted.code || '—'}</span>
                  </span>
                  {!r.matches && (
                    <>
                      <span className="text-gray-300 text-xs">→</span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                        <span className="font-mono">{r.reference.code || r.reference.name || '—'}</span>
                      </span>
                    </>
                  )}
                </div>
                <span className="flex-1 text-sm truncate min-w-0 hidden md:block">
                  {r.text
                    ? <span className="text-gray-600">{String(r.text).slice(0, 120)}{r.text.length > 120 ? '…' : ''}</span>
                    : <span className="text-amber-400 italic text-xs">← selecciona columna de texto en "Editar configuración"</span>
                  }
                </span>
                <ActionBadge action={r.recommendation.action} size="xs" />
                <span className="text-gray-300 text-xs shrink-0">{isOpen ? '▲' : '▼'}</span>
              </button>

              {/* Detalle expandido */}
              {isOpen && (
                <div className="border-t border-gray-100 bg-gray-50/50 px-5 py-4 space-y-4">
                  {/* Fila 1: Texto completo + justificación + evidencia */}
                  <div className="bg-white border border-gray-100 rounded-lg p-4">
                    <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-2">Texto original</p>
                    <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-words">
                      {r.text.replace(/\r/g, '')}
                    </p>
                    {(r.justification || r.evidence) && (
                      <div className="flex flex-wrap gap-6 mt-3 pt-3 border-t border-gray-100">
                        {r.justification && (
                          <div className="flex-1 min-w-52">
                            <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Justificación del modelo</p>
                            <p className="text-xs text-gray-600">{r.justification}</p>
                          </div>
                        )}
                        {r.evidence && (
                          <div className="flex-1 min-w-52">
                            <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Evidencia literal</p>
                            <p className="text-xs text-gray-600 italic">"{r.evidence}"</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Fila 2: Predicción | Referencia + Diagnóstico */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Predicción */}
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wide text-gray-400">Predicción del modelo</p>
                      <div className={`border rounded-lg p-3 ${r.matches ? 'bg-emerald-50 border-emerald-100' : 'bg-white border-gray-100'}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-mono text-[10px] text-gray-400">{r.predicted.code || '—'}</span>
                          {r.matches && <span className="text-[10px] text-emerald-600">✓ coincide con referencia</span>}
                        </div>
                        <p className="font-semibold text-gray-800">{predName || '—'}</p>
                        {showPredDef && (
                          <div className="mt-2 pt-2 border-t border-gray-100">
                            <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Definición en el modelo</p>
                            <p className="text-xs text-gray-500 leading-relaxed">{predDef}</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Referencia + diagnóstico */}
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wide text-gray-400">Referencia analista</p>
                      <div className="bg-white border border-blue-100 rounded-lg p-3">
                        <span className="font-mono text-[10px] text-gray-400">{r.reference.code || '—'}</span>
                        <p className="font-semibold text-gray-800 mt-1">{refName || '—'}</p>
                        {showRefDef && (
                          <div className="mt-2 pt-2 border-t border-blue-50">
                            <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Definición en el modelo</p>
                            <p className="text-xs text-gray-500 leading-relaxed">{refDef}</p>
                          </div>
                        )}
                      </div>
                      <div className={`rounded-lg p-3 border ${meta.border || 'border-gray-100'} ${meta.bg || 'bg-white'}`}>
                        <ActionBadge action={r.recommendation.action} size="xs" />
                        <p className={`text-xs leading-relaxed mt-1.5 ${meta.text || 'text-gray-600'}`}>{r.recommendation.reason}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {filteredReviewRows.length === 0 && (
          <div className="text-center text-sm text-gray-400 py-16">No hay casos que coincidan con el filtro seleccionado.</div>
        )}
      </div>
    </div>
  );
}

// ─── Tab: Acciones ────────────────────────────────────────────────────────────
function TabAcciones({ reviewedRows }) {
  const data = useMemo(() => {
    const catStats = {};

    reviewedRows.forEach(r => {
      const key = r.predicted.code || '__none__';
      if (!catStats[key]) catStats[key] = {
        code: key,
        name: r.predictedInfo?.name || r.predicted.name || key,
        total: 0, correct: 0,
        actions: {},
        confusions: {},
      };
      const cs = catStats[key];
      cs.total++;
      if (r.matches) cs.correct++;
      cs.actions[r.recommendation.action] = (cs.actions[r.recommendation.action] || 0) + 1;
      if (!r.matches && (r.reference.code || r.reference.name)) {
        const rk = r.reference.code || r.reference.name;
        cs.confusions[rk] = (cs.confusions[rk] || 0) + 1;
      }
    });

    // Categorías que funcionan bien
    const mantener = Object.values(catStats)
      .filter(c => c.total > 0 && c.correct / c.total >= 0.65)
      .map(c => ({ ...c, accuracy: c.correct / c.total }))
      .sort((a, b) => b.accuracy - a.accuracy);

    // Por acción de error: categorías que presentan ese tipo de error
    const byAction = {};
    Object.values(catStats).forEach(cat => {
      const accuracy = cat.total ? cat.correct / cat.total : 0;
      Object.entries(cat.actions).forEach(([action, count]) => {
        if (action === 'Mantener' || action === 'Completar referencia') return;
        if (!byAction[action]) byAction[action] = [];
        if (!byAction[action].find(c => c.code === cat.code)) {
          byAction[action].push({
            ...cat, accuracy, actionCount: count,
            sortedConfusions: Object.entries(cat.confusions).sort((a, b) => b[1] - a[1]),
          });
        }
      });
    });
    // ordenar cada grupo por actionCount desc
    Object.values(byAction).forEach(arr => arr.sort((a, b) => b.actionCount - a.actionCount));

    // Nuevas categorías (referencias que no están en el modelo)
    const newCatCounts = {};
    reviewedRows.forEach(r => {
      if (r.recommendation.action === 'Crear categoría' && !r.referenceInfo) {
        const key = r.reference.code || r.reference.name;
        if (!key) return;
        if (!newCatCounts[key]) newCatCounts[key] = { label: key, count: 0 };
        newCatCounts[key].count++;
      }
    });
    const newCats = Object.values(newCatCounts).sort((a, b) => b.count - a.count);

    // Casos sin referencia
    const sinRef = reviewedRows.filter(r => r.recommendation.action === 'Completar referencia');

    return { mantener, byAction, newCats, sinRef };
  }, [reviewedRows]);

  const ERROR_ORDER = ['Modificar definición', 'Revisar solape', 'Reforzar definición', 'Crear categoría'];

  return (
    <div className="pt-4 space-y-4">
      {/* Mantener */}
      {data.mantener.length > 0 && (
        <ActionSection
          action="Mantener"
          desc={ACTION_DESC['Mantener']}
          count={data.mantener.length}
          countLabel="con buen rendimiento"
        >
          <div className="divide-y divide-gray-100">
            {data.mantener.map(cat => (
              <div key={cat.code} className="flex items-center gap-4 py-2 first:pt-0 last:pb-0">
                {/* Código + nombre */}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="font-mono text-[10px] text-gray-400 shrink-0">{cat.code}</span>
                  <span className="text-sm text-gray-800 truncate">{cat.name}</span>
                </div>
                {/* Ratio + barra */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-gray-400 tabular-nums">{cat.correct}/{cat.total} correctos</span>
                  <div className="w-20 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.round(cat.accuracy * 100)}%` }} />
                  </div>
                  <span className="text-sm font-bold text-emerald-600 tabular-nums w-10 text-right">
                    {Math.round(cat.accuracy * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </ActionSection>
      )}

      {/* Errores por tipo */}
      {ERROR_ORDER.map(action => {
        const cats = data.byAction[action];
        if (!cats || cats.length === 0) return null;

        return (
          <ActionSection key={action} action={action} desc={ACTION_DESC[action]} count={cats.length}>
            {action === 'Crear categoría' && data.newCats.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-amber-600 mb-2">Referencias usadas por analistas que no están en el modelo cargado:</p>
                <div className="flex flex-wrap gap-2">
                  {data.newCats.map(nc => (
                    <div key={nc.label} className="flex items-center gap-2 bg-white border border-amber-100 rounded-lg px-3 py-1.5 text-xs">
                      <span className="font-medium text-gray-800">{nc.label}</span>
                      <span className="text-amber-600 font-semibold">{nc.count} {nc.count === 1 ? 'caso' : 'casos'}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {cats.map(cat => (
                  <div key={cat.code} className="bg-white border border-gray-100 rounded-lg px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-[10px] text-gray-400 shrink-0">{cat.code}</span>
                        <span className="text-sm font-medium text-gray-800 truncate">{cat.name}</span>
                      </div>
                      <span className="text-xs tabular-nums text-gray-500 shrink-0">
                        {cat.actionCount} {cat.actionCount === 1 ? 'caso' : 'casos'}
                      </span>
                    </div>
                    {cat.sortedConfusions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        <span className="text-[10px] text-gray-400 self-center">Se confunde con:</span>
                        {cat.sortedConfusions.slice(0, 4).map(([refKey, cnt]) => (
                          <span key={refKey} className="text-[10px] bg-gray-50 border border-gray-200 rounded-md px-2 py-0.5 text-gray-600">
                            <span className="font-mono">{refKey}</span>
                            <span className="text-gray-400"> · {cnt}x</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ActionSection>
        );
      })}

      {/* Sin referencia */}
      {data.sinRef.length > 0 && (
        <ActionSection action="Completar referencia" desc={ACTION_DESC['Completar referencia']} count={data.sinRef.length}>
          <p className="text-sm text-slate-600">
            {data.sinRef.length} {data.sinRef.length === 1 ? 'caso sin' : 'casos sin'} etiqueta de referencia.
            IDs: {data.sinRef.slice(0, 20).map(r => `#${r.id}`).join(', ')}{data.sinRef.length > 20 ? ` y ${data.sinRef.length - 20} más…` : ''}
          </p>
        </ActionSection>
      )}
    </div>
  );
}

function ActionSection({ action, desc, count, countLabel, children }) {
  const [open, setOpen] = useState(true);
  const meta = ACTION_META[action] || { bg: 'bg-gray-50', text: 'text-gray-600', border: 'border-gray-200' };
  const label = countLabel || (count === 1 ? 'categoría afectada' : 'categorías afectadas');
  return (
    <div className={`rounded-xl border ${meta.border} overflow-hidden`}>
      <button
        className={`w-full flex items-center justify-between px-4 py-3 ${meta.bg} hover:opacity-90 transition-opacity`}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-3">
          <ActionBadge action={action} />
          <span className={`text-sm font-medium ${meta.text}`}>{count} {label}</span>
        </div>
        <span className={`text-xs ${meta.text} opacity-60`}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="bg-white px-4 py-3 space-y-2">
          <p className={`text-xs mb-3 ${meta.text} opacity-80`}>{desc}</p>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── SetupPanel (colapsable) ──────────────────────────────────────────────────
function SetupPanel({
  reviewModel, reviewModelLabel, modelInfo,
  dataRows, dataFileName,
  textColumn, setTextColumn,
  predictedColumn, setPredictedColumn,
  referenceColumn, setReferenceColumn,
  justificationColumn, setJustificationColumn,
  evidenceColumn, setEvidenceColumn,
  columns,
  onModelFile, onDataFile,
}) {
  const isComplete = reviewModel && dataRows.length > 0 && textColumn && predictedColumn && referenceColumn;
  const [open, setOpen] = useState(true);

  useEffect(() => { if (isComplete) setOpen(false); }, [isComplete]);

  if (!open) {
    return (
      <div className="flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3 shadow-sm">
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-gray-500">Modelo:</span>
            <span className="font-medium text-gray-800">{reviewModelLabel}</span>
            <span className="text-gray-400">· {Object.keys(modelInfo.categories).length} cat.</span>
          </div>
          <span className="text-gray-300">|</span>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-gray-500">Datos:</span>
            <span className="font-medium text-gray-800">{dataFileName}</span>
            <span className="text-gray-400">· {dataRows.length.toLocaleString()} filas</span>
          </div>
        </div>
        <button onClick={() => setOpen(true)} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
          Editar configuración
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-[#171433]">1. Modelo de categorías</h3>
            {reviewModel && <span className="text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">Cargado</span>}
          </div>
          <input type="file" accept=".json" onChange={onModelFile} className="block w-full text-sm mb-2" />
          <p className="text-xs text-gray-400">JSON con códigos WMAnnn y sus definiciones.</p>
          {reviewModel && (
            <div className="mt-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
              <strong>{reviewModelLabel}</strong> · {Object.keys(modelInfo.categories).length} categorías detectadas
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-[#171433]">2. Resultados etiquetados</h3>
            {dataRows.length > 0 && <span className="text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">Cargado</span>}
          </div>
          <input type="file" accept=".csv,.xlsx" onChange={onDataFile} className="block w-full text-sm mb-2" />
          <p className="text-xs text-gray-400">CSV o Excel con columna de predicción del modelo y referencia del analista.</p>
          {dataRows.length > 0 && (
            <div className="mt-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
              <strong>{dataFileName}</strong> · {dataRows.length.toLocaleString()} filas
            </div>
          )}
        </div>
      </div>

      {dataRows.length > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm">
          <h3 className="font-semibold text-[#171433] mb-3">3. Mapeo de columnas</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {[
              ['Texto',               textColumn,          setTextColumn,          true],
              ['Etiqueta modelo',     predictedColumn,     setPredictedColumn,     true],
              ['Referencia analista', referenceColumn,     setReferenceColumn,     true],
              ['Justificación',       justificationColumn, setJustificationColumn, false],
              ['Evidencia',           evidenceColumn,      setEvidenceColumn,      false],
            ].map(([label, value, setter, required]) => (
              <label key={label} className="text-xs text-gray-500">
                <span>{label}{required && <span className="text-red-400 ml-0.5">*</span>}</span>
                <select
                  value={value}
                  onChange={e => setter(e.target.value)}
                  className={`mt-1 block w-full border rounded-lg px-2 py-1.5 text-sm text-gray-700 focus:outline-none ${
                    required && !value ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
                  }`}
                >
                  <option value="">-- Selecciona --</option>
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            ))}
          </div>
          {isComplete && (
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => setOpen(false)}
                className="text-sm px-4 py-2 rounded-lg bg-[#171433] text-white hover:bg-[#0f0e24] transition-colors"
              >
                Ir al análisis →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers de formato maestro "Nombre [definición]" ─────────────────────────
// Parsea un valor del maestro en { name, definition }. El nombre es el texto antes
// del primer '['; la definición es el contenido entre el primer '[' y el último ']'.
function parseMasterEntry(value) {
  const str = String(value ?? '').trim();
  const open = str.indexOf('[');
  const close = str.lastIndexOf(']');
  if (open === -1 || close === -1 || close < open) {
    return { name: str, definition: '' };
  }
  return {
    name: str.slice(0, open).trim(),
    definition: str.slice(open + 1, close).trim(),
  };
}

// Limpia una definición que pueda venir con brackets exteriores y/o un prefijo
// de código/nombre embebido (ej. "WMA311 [texto]" → "texto"). Itera hasta estabilizar.
function cleanDefinition(value) {
  let d = String(value ?? '').trim();
  for (let i = 0; i < 4; i++) {
    const m = d.match(/^[^[\]]*\[([\s\S]*)\]\s*$/);
    if (m) { d = m[1].trim(); continue; }
    break;
  }
  return d.replace(/^\[+|\]+$/g, '').trim();
}

// ─── Footer de corrección ─────────────────────────────────────────────────────
function CorrFooter({ nAccepted, hasCatalog, corrMerged, onMerge, onExport }) {
  return (
    <div className="pt-4 mt-2 border-t border-slate-100 flex items-center gap-3">
      <button
        onClick={onMerge}
        disabled={nAccepted === 0}
        className={`px-4 py-2 rounded-lg text-sm font-semibold shadow-sm transition-all ${
          nAccepted === 0
            ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
            : 'bg-indigo-600 hover:bg-indigo-700 text-white active:scale-[0.98]'
        }`}
      >
        Unir al maestro
        {nAccepted > 0 && (
          <span className="ml-1.5 text-indigo-200 font-normal text-xs">
            ({nAccepted} categor{nAccepted === 1 ? 'ía' : 'ías'})
          </span>
        )}
      </button>

      {!hasCatalog && nAccepted > 0 && (
        <p className="text-xs text-amber-600">
          Sin catálogo de referencia — se exportarán solo las categorías modificadas.
        </p>
      )}

      {corrMerged && (
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-emerald-600 font-medium">
            ✓ Maestro listo · {Object.keys(corrMerged).length} categorías
          </span>
          <button
            onClick={onExport}
            className="px-4 py-2 rounded-lg text-sm font-semibold border border-indigo-300 bg-white text-indigo-700 hover:bg-indigo-50 shadow-sm transition-colors"
          >
            Exportar JSON
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
function AutoQA() {
  const [models,        setModels]        = useState([]);
  const [tab,           setTab]           = useState('judge');
  const [searchTerm,    setSearchTerm]    = useState('');
  const [file,          setFile]          = useState(null);
  const [modelName,     setModelName]     = useState('');
  const [isModalOpen,   setIsModalOpen]   = useState(false);
  const [modelToDelete, setModelToDelete] = useState(null);

  const [reviewModel,         setReviewModel]         = useState(null);
  const [reviewModelLabel,    setReviewModelLabel]     = useState('');
  const [dataRows,            setDataRows]             = useState([]);
  const [dataFileName,        setDataFileName]         = useState('');
  const [textColumn,          setTextColumn]           = useState('');
  const [predictedColumn,     setPredictedColumn]      = useState('');
  const [referenceColumn,     setReferenceColumn]      = useState('');
  const [justificationColumn, setJustificationColumn]  = useState('');
  const [evidenceColumn,      setEvidenceColumn]       = useState('');
  const [reviewFilter,        setReviewFilter]         = useState('errores');
  const [reviewSearch,        setReviewSearch]         = useState('');
  const [reviewTab,           setReviewTab]            = useState('resumen');

  // ── LLM-as-a-Judge state ──
  const [judgeModel,       setJudgeModel]       = useState(null);
  const [judgeModelLabel,  setJudgeModelLabel]  = useState('');
  const [judgeDataRows,    setJudgeDataRows]    = useState([]);
  const [judgeDataFile,    setJudgeDataFile]    = useState('');
  const [judgeTextCol,     setJudgeTextCol]     = useState('');
  const [judgePredCol,     setJudgePredCol]     = useState('');
  const [judgeJustCol,     setJudgeJustCol]     = useState('');
  const [judgeColumns,     setJudgeColumns]     = useState([]);
  const [judgeRunning,     setJudgeRunning]     = useState(false);
  const [judgeProgress,    setJudgeProgress]    = useState(0);
  const [judgeResults,     setJudgeResults]     = useState([]);
  const [judgeError,       setJudgeError]       = useState('');

  // ── Corrección state ──
  const [corrRunning,     setCorrRunning]      = useState(false);
  const [corrProgress,    setCorrProgress]     = useState(0);
  const [corrRedefine,    setCorrRedefine]     = useState([]);   // Redefiniciones por categoría
  const [corrMerged,      setCorrMerged]       = useState(null); // Maestro fusionado listo para exportar
  // Archivo propio del tab Corrección
  const [corrFileRows,    setCorrFileRows]     = useState([]);
  const [corrFileColumns, setCorrFileColumns]  = useState([]);
  const [corrFileName,    setCorrFileName]     = useState('');
  const [corrTextCol,     setCorrTextCol]      = useState('');
  const [corrCatCol,      setCorrCatCol]       = useState('');
  const [corrVerdictCol,  setCorrVerdictCol]   = useState('');
  const [corrCatalogJson, setCorrCatalogJson]  = useState(null);

  // ── Modelos Azure ──
  const fetchModels = async () => {
    try { const r = await axios.get(`${API_BASE}/models`); setModels(r.data); }
    catch { console.error('Error fetching models'); }
  };
  useEffect(() => { fetchModels(); }, []);

  const handleDelete    = (name) => { setModelToDelete(name); setIsModalOpen(true); };
  const cancelDelete    = () => { setIsModalOpen(false); setModelToDelete(null); };
  const confirmDelete   = async () => {
    if (!modelToDelete) return;
    try { await axios.post(`${API_BASE}/delete`, { model_name: modelToDelete }); fetchModels(); }
    catch { console.error('Error deleting'); }
    finally { setIsModalOpen(false); setModelToDelete(null); }
  };
  const handleDownload = async (name) => {
    try {
      const r    = await axios.get(`${API_BASE}/models/${name}`);
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), { href: url, download: `${name}.json` });
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch { alert('No se pudo descargar el modelo.'); }
  };
  const handleUpload = async (e) => {
    e.preventDefault();
    if (!file || !modelName) { alert('Proporciona nombre y archivo.'); return; }
    const fd = new FormData();
    fd.append('modelFile', file); fd.append('model_name', modelName);
    try {
      await axios.post(`${API_BASE}/add`, fd);
      setModelName(''); setFile(null);
      document.getElementById('file-input').value = '';
      fetchModels();
    } catch { console.error('Error uploading'); }
  };

  const filteredModels = models.filter(m => m.toLowerCase().includes(searchTerm.toLowerCase()));

  // ── Cómputos de revisión ──
  const modelInfo  = useMemo(() => normalizeModel(reviewModel), [reviewModel]);
  const columns    = useMemo(() => Object.keys(dataRows[0] || {}), [dataRows]);

  const reviewedRows = useMemo(() => dataRows.map((row, idx) => {
    const predicted     = splitCodeName(row[predictedColumn]);
    const reference     = splitCodeName(row[referenceColumn]);
    const predictedInfo = modelInfo.categories[predicted.code];
    const referenceInfo = modelInfo.categories[reference.code];
    const matches       = Boolean(reference.code && predicted.code && reference.code === predicted.code);
    return {
      id: idx + 1, row, text: String(row[textColumn] ?? ''),
      predicted, reference, predictedInfo, referenceInfo,
      justification: String(row[justificationColumn] ?? ''),
      evidence:      String(row[evidenceColumn]      ?? ''),
      matches,
      recommendation: recommendAction({ predicted, reference, predictedInfo, referenceInfo }),
    };
  }), [dataRows, predictedColumn, referenceColumn, textColumn, justificationColumn, evidenceColumn, modelInfo]);

  const reviewStats = useMemo(() => {
    const withRef = reviewedRows.filter(r => r.reference.code || r.reference.name);
    const correct = withRef.filter(r => r.matches).length;
    const actions = {};
    reviewedRows.forEach(r => { actions[r.recommendation.action] = (actions[r.recommendation.action] || 0) + 1; });
    return {
      total: reviewedRows.length,
      withReference: withRef.length,
      correct,
      errors: withRef.length - correct,
      accuracy: withRef.length ? correct / withRef.length : null,
      actions,
    };
  }, [reviewedRows]);

  const filteredReviewRows = useMemo(() => {
    const q = normalizeText(reviewSearch);
    return reviewedRows.filter(r => {
      if (reviewFilter === 'errores'   && r.matches) return false;
      if (reviewFilter === 'correctos' && !r.matches) return false;
      if (reviewFilter === 'otros'     && !SPECIAL_OTHER_CODES.has(r.predicted.code)) return false;
      if (reviewFilter === 'crear'     && r.recommendation.action !== 'Crear categoría') return false;
      if (!q) return true;
      return [r.text, r.predicted.code, r.predicted.name, r.reference.code, r.reference.name, r.justification, r.evidence, r.recommendation.action]
        .some(v => normalizeText(v).includes(q));
    });
  }, [reviewedRows, reviewFilter, reviewSearch]);

  const categorySummary = useMemo(() => {
    const summary = {};
    reviewedRows.forEach(r => {
      const key = r.predicted.code || '(sin predicción)';
      if (!summary[key]) summary[key] = { code: key, name: r.predictedInfo?.name || r.predicted.name || key, total: 0, errors: 0, references: {}, actions: {} };
      summary[key].total += 1;
      if (!r.matches) summary[key].errors += 1;
      const rk = r.reference.code || r.reference.name || '(sin referencia)';
      summary[key].references[rk] = (summary[key].references[rk] || 0) + 1;
      summary[key].actions[r.recommendation.action] = (summary[key].actions[r.recommendation.action] || 0) + 1;
    });
    return Object.values(summary).map(item => ({
      ...item,
      errorRate:    item.total ? item.errors / item.total : 0,
      topReference: Object.entries(item.references).sort((a, b) => b[1] - a[1])[0],
      topAction:    Object.entries(item.actions).sort((a, b) => b[1] - a[1])[0],
    })).sort((a, b) => b.errors - a.errors || b.total - a.total).slice(0, 12);
  }, [reviewedRows]);

  // ── Descarga Excel ──
  async function downloadReviewReport() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'AutoQA'; wb.created = new Date();

    // ── Hoja 1: Datos ──
    const ws1 = wb.addWorksheet('Datos');
    const inputCols = columns.filter(c => c !== predictedColumn && c !== referenceColumn && c !== justificationColumn && c !== evidenceColumn);
    const h1 = ['ID', ...inputCols, 'CategoriaPredicha', 'ReferenciaAnalista', 'Coincide', 'Accion', 'Diagnostico'];
    if (justificationColumn) h1.push('Justificacion');
    if (evidenceColumn) h1.push('Evidencia');

    ws1.addRow(h1);
    const hRow1 = ws1.getRow(1);
    hRow1.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hRow1.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF171433' } };
    hRow1.alignment = { vertical: 'middle' };
    ws1.getRow(1).height = 20;

    reviewedRows.forEach(r => {
      const pred = r.predicted.code ? `${r.predicted.code} - ${r.predictedInfo?.name || r.predicted.name}` : r.predicted.name;
      const ref  = r.reference.code  ? `${r.reference.code} - ${r.referenceInfo?.name || r.reference.name}` : r.reference.name;
      const row  = [r.id, ...inputCols.map(c => r.row[c] ?? ''), pred, ref, r.matches ? 'Sí' : 'No', r.recommendation.action, r.recommendation.reason];
      if (justificationColumn) row.push(r.justification);
      if (evidenceColumn)      row.push(r.evidence);
      const dr = ws1.addRow(row);
      if (!r.matches) {
        dr.getCell(inputCols.length + 3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      }
    });
    ws1.columns.forEach(col => { col.width = Math.min(60, Math.max(12, (col.width || 12))); });

    // ── Hoja 2: Resumen ──
    const ws2 = wb.addWorksheet('Resumen');
    ws2.addRow(['Métrica', 'Valor']);
    ws2.getRow(1).font = { bold: true }; ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    [
      ['Casos totales',  reviewStats.total],
      ['Con referencia', reviewStats.withReference],
      ['Correctos',      reviewStats.correct],
      ['Errores',        reviewStats.errors],
      ['Accuracy',       reviewStats.accuracy !== null ? `${Math.round(reviewStats.accuracy * 100)}%` : 'N/A'],
    ].forEach(r => ws2.addRow(r));

    ws2.addRow([]);
    ws2.addRow(['Acción sugerida', 'Casos', '% del total']);
    ws2.lastRow.font = { bold: true }; ws2.lastRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    Object.entries(reviewStats.actions).sort((a, b) => b[1] - a[1]).forEach(([action, count]) => {
      ws2.addRow([action, count, reviewStats.total ? `${Math.round(count / reviewStats.total * 100)}%` : '0%']);
    });
    ws2.getColumn(1).width = 28; ws2.getColumn(2).width = 12; ws2.getColumn(3).width = 16;

    // ── Hoja 3: Hallazgos ──
    const ws3 = wb.addWorksheet('Hallazgos por categoría');
    ws3.addRow(['Código', 'Categoría', 'Total casos', 'Errores', '% error', 'Referencia más frecuente', 'Acción principal']);
    ws3.getRow(1).font = { bold: true }; ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    categorySummary.forEach(item => {
      const row = ws3.addRow([
        item.code, item.name, item.total, item.errors,
        `${Math.round(item.errorRate * 100)}%`,
        item.topReference ? `${item.topReference[0]} (${item.topReference[1]} de ${item.total} casos)` : '—',
        item.topAction ? item.topAction[0] : '—',
      ]);
      const errPct = item.errorRate;
      if (errPct > 0.5)      row.getCell(5).font = { color: { argb: 'FFDC2626' } };
      else if (errPct > 0.25) row.getCell(5).font = { color: { argb: 'FFD97706' } };
      else                    row.getCell(5).font = { color: { argb: 'FF059669' } };
    });
    [28, 40, 14, 10, 12, 40, 28].forEach((w, i) => { ws3.getColumn(i + 1).width = w; });

    const buffer = await wb.xlsx.writeBuffer();
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url    = URL.createObjectURL(blob);
    const a      = Object.assign(document.createElement('a'), { href: url, download: `autoqa-revision-${new Date().toISOString().slice(0, 10)}.xlsx` });
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  async function handleReviewModelFile(event) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    try { const json = await readJsonFile(selected); setReviewModel(json); setReviewModelLabel(selected.name); }
    catch { alert('No se pudo leer el JSON del modelo.'); }
  }

  async function handleReviewDataFile(event) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    try {
      const rows = await readDataFile(selected);
      setDataRows(rows); setDataFileName(selected.name);
      const nc = Object.keys(rows[0] || {});
      setTextColumn(          inferColumn(nc, ['texto','text','mensaje','comentario','body','verbatim','contenido','descripcion','detalle']));
      setPredictedColumn(     inferColumn(nc, ['CategoriaAsignada','categoria asignada','predicho','modelo']) || '');
      setReferenceColumn(     inferColumn(nc, ['ReferenciaAnalista','referencia analista','categoria correcta','ground truth','esperado']) || '');
      setJustificationColumn( inferColumn(nc, ['Justificacion','justificacion','justification'])       || '');
      setEvidenceColumn(      inferColumn(nc, ['Evidencia','evidencia','evidence'])                    || '');
    } catch { alert('No se pudo leer el archivo de resultados.'); }
  }

  const hasResults = reviewedRows.length > 0 && predictedColumn && referenceColumn;

  // ── LLM-as-a-Judge: carga archivos ──
  async function handleJudgeModelFile(f) {
    if (!f) return;
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      const flat = typeof Object.values(json)[0] === 'string' ? json
        : Object.fromEntries(Object.values(json).flatMap(v => typeof v === 'object' ? Object.entries(v) : []));
      setJudgeModel(flat);
      setJudgeModelLabel(f.name.replace('.json', ''));
    } catch { alert('JSON de categorías inválido.'); }
  }

  async function handleJudgeDataFile(f) {
    if (!f) return;
    try {
      let rows = [];
      if (f.name.toLowerCase().endsWith('.xls')) {
        throw new Error('Formato .xls (Excel 97-2003) no soportado. Guarda el archivo como .xlsx e inténtalo de nuevo.');
      } else if (f.name.endsWith('.csv')) {
        await new Promise(resolve => Papa.parse(f, { header: true, skipEmptyLines: true, complete: r => { rows = r.data; resolve(); } }));
      } else if (f.name.toLowerCase().endsWith('.xlsx')) {
        const buf = await f.arrayBuffer();
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
        const ws = wb.worksheets[0];
        const headers = []; ws.getRow(1).eachCell(c => headers.push(c.text));
        ws.eachRow((row, ri) => { if (ri === 1) return; const r = {}; row.eachCell((c, ci) => { r[headers[ci-1]] = String(c.value ?? ''); }); rows.push(r); });
      } else {
        throw new Error('Formato de archivo no soportado.');
      }
      setJudgeDataRows(rows);
      setJudgeDataFile(f.name);
      const cols = Object.keys(rows[0] || {});
      setJudgeColumns(cols);
      setJudgeTextCol(inferColumn(cols, ['texto','text','mensaje','comentario','body','verbatim','contenido']) || '');
      setJudgePredCol(inferColumn(cols, ['CategoriaAsignada','categoria asignada','predicho','modelo']) || '');
      setJudgeJustCol(inferColumn(cols, ['Justificacion','justificacion','justification']) || '');
    } catch (e) { alert(e.message || 'No se pudo leer el archivo de resultados.'); }
  }

  async function runJudge() {
    if (!judgeDataRows.length || !judgeTextCol || !judgePredCol) return;
    setJudgeRunning(true); setJudgeProgress(0); setJudgeResults([]); setJudgeError('');
    const total = judgeDataRows.length;
    const results = new Array(total);
    let completed = 0; let nextIdx = 0;
    const CONCURRENCY = 8;

    const worker = async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= total) return;
        const row = judgeDataRows[idx];
        const text = String(row[judgeTextCol] || '');
        const assigned = String(row[judgePredCol] || '');
        const justification = judgeJustCol ? String(row[judgeJustCol] || '') : '';
        const code = assigned.split(' - ')[0].trim();
        const definition = judgeModel?.[code] ?? judgeModel?.[assigned] ?? '';
        try {
          const resp = await axios.post(`${API_BASE}/proxy/judge`, { text, assigned_category: assigned, definition, justification }, { timeout: 90000 });
          results[idx] = { ...row, _judgeVotes: resp.data.votes, _judgeConsensus: resp.data.consensus, _judgeAgreements: resp.data.agreements, _judgeTotal: resp.data.total };
        } catch (e) {
          results[idx] = { ...row, _judgeVotes: [], _judgeConsensus: null, _judgeError: e.message };
        }
        completed++;
        setJudgeProgress(Math.round((completed / total) * 100));
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));
      setJudgeResults(results);
    } catch (e) { setJudgeError(e.message); }
    finally { setJudgeRunning(false); }
  }

  // Métricas F1 por categoría
  const judgeMetrics = useMemo(() => {
    if (!judgeResults.length) return null;
    const byCode = {};
    judgeResults.forEach(r => {
      const code = String(r[judgePredCol] || '').split(' - ')[0].trim() || '(sin código)';
      if (!byCode[code]) byCode[code] = { code, label: r[judgePredCol] || code, tp: 0, fp: 0, fn: 0 };
      const agreed = r._judgeConsensus === true;
      if (agreed) byCode[code].tp++;
      else { byCode[code].fp++; byCode[code].fn++; }
    });
    const items = Object.values(byCode).map(c => {
      const precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : 0;
      const recall    = c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : 0;
      const f1        = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
      return { ...c, precision, recall, f1, total: c.tp + c.fp };
    }).sort((a, b) => b.total - a.total);
    const macroF1 = items.length ? items.reduce((s, c) => s + c.f1, 0) / items.length : 0;
    const overallAgreements = judgeResults.filter(r => r._judgeConsensus === true).length;
    return { items, macroF1, accuracy: judgeResults.length ? overallAgreements / judgeResults.length : 0, total: judgeResults.length };
  }, [judgeResults, judgePredCol]);

  async function downloadJudgeReport() {
    if (!judgeResults.length) return;
    const wb = new ExcelJS.Workbook();
    const ws1 = wb.addWorksheet('Juicios');
    ws1.addRow(['#', judgeTextCol, judgePredCol, 'Claude', 'Razón Claude', 'Gemini', 'Razón Gemini', 'Veredicto']).font = { bold: true };
    judgeResults.forEach((r, i) => {
      const votes = r._judgeVotes || [];
      const cv = votes.find(v => v.source === 'claude') || {};
      const gv = votes.find(v => v.source === 'gemini');
      const consensus = r._judgeConsensus;
      ws1.addRow([
        i+1,
        r[judgeTextCol] ?? '',
        r[judgePredCol] ?? '',
        cv.acuerdo != null ? (cv.acuerdo ? 'Sí' : 'No') : 'error',
        cv.razon ?? '',
        gv ? (gv.acuerdo != null ? (gv.acuerdo ? 'Sí' : 'No') : 'error') : '—',
        gv?.razon ?? '—',
        consensus === true ? 'Correcto' : consensus === false ? 'Revisar' : 'Desacuerdo',
      ]);
    });
    if (judgeMetrics) {
      const ws2 = wb.addWorksheet('Métricas');
      ws2.addRow(['Código', 'Categoría', 'Total', 'Precisión', 'Recall', 'F1']).font = { bold: true };
      judgeMetrics.items.forEach(c => ws2.addRow([c.code, c.label, c.total, c.precision.toFixed(3), c.recall.toFixed(3), c.f1.toFixed(3)]));
      ws2.addRow([]);
      ws2.addRow(['', 'Macro F1', '', '', '', judgeMetrics.macroF1.toFixed(3)]);
      ws2.addRow(['', 'Accuracy', '', judgeMetrics.accuracy.toFixed(3)]);
    }
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `llm-judge-${new Date().toISOString().slice(0,10)}.xlsx`; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // ── Corrección: cargar archivo propio (CSV / XLSX / XLS) ──
  async function handleCorrFile(f) {
    if (!f) return;
    try {
      let rows = [];
      if (f.name.toLowerCase().endsWith('.xls')) {
        throw new Error('Formato .xls (Excel 97-2003) no soportado. Guarda el archivo como .xlsx e inténtalo de nuevo.');
      } else if (f.name.toLowerCase().endsWith('.csv')) {
        await new Promise(resolve => Papa.parse(f, { header: true, skipEmptyLines: true, complete: r => { rows = r.data; resolve(); } }));
      } else if (f.name.toLowerCase().endsWith('.xlsx')) {
        const buf = await f.arrayBuffer();
        const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(buf);
        const ws = wb2.worksheets[0];
        const headers = []; ws.getRow(1).eachCell(c => headers.push(c.text));
        ws.eachRow((row, ri) => { if (ri === 1) return; const r = {}; row.eachCell((c, ci) => { r[headers[ci-1]] = String(c.value ?? ''); }); rows.push(r); });
      } else {
        throw new Error('Formato de archivo no soportado.');
      }
      setCorrFileRows(rows);
      setCorrFileName(f.name);
      const cols = Object.keys(rows[0] || {});
      setCorrFileColumns(cols);
      // Auto-inferir columnas
      setCorrTextCol(inferColumn(cols, ['texto','text','mensaje','comentario','body','verbatim','contenido']) || '');
      setCorrCatCol(inferColumn(cols, ['CategoriaAsignada','categoria asignada','categoria','predicho','modelo','label']) || '');
      setCorrVerdictCol(inferColumn(cols, ['Veredicto','veredicto','verdict','juicio','resultado']) || '');
      // Limpiar resultados previos
      setCorrRedefine([]);
    } catch (e) { alert(e.message || 'No se pudo leer el archivo. Verifica que sea CSV o XLSX válido.'); }
  }

  async function handleCorrCatalogFile(f) {
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const flat = {};
      const addCat = (code, val) => { if (typeof val === 'string') flat[code] = val; else if (val?.definition) flat[code] = val.definition; };
      Object.entries(raw).forEach(([k, v]) => {
        if (typeof v === 'string') { flat[k] = v; return; }
        if (v?.definition) { flat[k] = v.definition; }
        if (v?.subcategories) Object.entries(v.subcategories).forEach(([ck, cv]) => addCat(ck, cv));
        Object.entries(v).forEach(([ck, cv]) => { if (/^WM[A-Z]?\d{3}$/i.test(ck)) addCat(ck, cv); });
      });
      setCorrCatalogJson(flat);
    } catch { alert('JSON de catálogo inválido.'); }
  }

  // ── Filas malas: desde archivo propio (filtrado) o fallback al judge ──
  const corrBadRows = useMemo(() => {
    if (corrFileRows.length > 0) {
      if (!corrVerdictCol) return corrFileRows; // sin filtro: todas las filas
      return corrFileRows.filter(r => {
        const val = String(r[corrVerdictCol] ?? '').toLowerCase();
        return val === 'no' || val === 'revisar' || val === 'false';
      });
    }
    // fallback: usar resultados del judge
    return judgeResults.filter(r => r._judgeConsensus === false);
  }, [corrFileRows, corrVerdictCol, judgeResults]);

  // Columnas efectivas para corrección (propias o las del judge como fallback)
  const corrEffTextCol = corrFileRows.length > 0 ? corrTextCol : judgeTextCol;
  const corrEffCatCol  = corrFileRows.length > 0 ? corrCatCol  : judgePredCol;
  const corrEffCatalog = corrFileRows.length > 0 ? corrCatalogJson : judgeModel;

  // (legacy alias para el badge de la pestaña)
  const badRows = useMemo(
    () => judgeResults.filter(r => r._judgeConsensus === false),
    [judgeResults]
  );

  // ── Corrección: redefinir categorías ──
  async function runCorrectionRedefine() {
    if (!corrBadRows.length) return;
    setCorrRunning(true); setCorrProgress(0); setCorrRedefine([]); setCorrMerged(null);

    // Agrupar por categoría asignada
    const groups = {};
    corrBadRows.forEach(r => {
      const cat = String(r[corrEffCatCol] || '(sin categoría)');
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(String(r[corrEffTextCol] || ''));
    });
    const entries = Object.entries(groups);
    const total = entries.length;
    const results = new Array(total);
    let completed = 0;

    await Promise.all(entries.map(async ([category, examples], idx) => {
      const code = category.split(' - ')[0].trim();
      const masterVal = corrEffCatalog?.[code] ?? corrEffCatalog?.[category] ?? '';
      // Parsea el valor del maestro: solo la definición se envía al modelo y al diff
      const { name: catName, definition: cleanCurrentDef } = parseMasterEntry(masterVal);
      const current_definition = cleanCurrentDef;
      try {
        const resp = await axios.post(`${API_BASE}/proxy/correct`, {
          mode: 'redefine', category, current_definition, wrong_examples: examples,
        }, { timeout: 90000 });
        const suggested = cleanDefinition(resp.data.suggested_definition ?? '');
        results[idx] = {
          code, catName, category, current_definition, action: 'redefine',
          suggested_definition: suggested, razon: resp.data.razon ?? '',
          count: examples.length, status: 'pending', editValue: suggested,
        };
      } catch (e) {
        results[idx] = { code, catName, category, current_definition, action: 'redefine', suggested_definition: '', razon: e.message, count: examples.length, status: 'error', editValue: '' };
      }
      completed++;
      setCorrProgress(Math.round((completed / total) * 100));
    }));
    setCorrRedefine(results);
    setCorrRunning(false);
  }

  function runCorrection() { runCorrectionRedefine(); }

  // ── Actualizar estado de corrección (accept/reject) ──
  function setCorrItemStatus(idx, status) {
    setCorrRedefine(prev => prev.map((r, i) => i === idx ? { ...r, status } : r));
  }
  function setCorrItemEdit(idx, value) {
    setCorrRedefine(prev => prev.map((r, i) => i === idx ? { ...r, editValue: value } : r));
  }
  function setCorrItemName(idx, value) {
    setCorrRedefine(prev => prev.map((r, i) => i === idx ? { ...r, editName: value } : r));
  }

  // ── Unir aceptadas sobre el maestro de referencia ──
  function mergeToCatalog() {
    const accepted = corrRedefine.filter(r => r.status === 'accepted');
    if (!accepted.length) return;

    // Copia del catálogo original (o vacío si no se cargó)
    const merged = { ...(corrEffCatalog || {}) };

    accepted.forEach(r => {
      const code = r.code || r.category.split(' - ')[0]?.trim() || r.category;
      const name = r.catName || r.category.split(' - ').slice(1).join(' - ').trim() || code;
      const def  = cleanDefinition(r.editValue || r.suggested_definition);
      merged[code] = def ? `${name} [${def}]` : name;
    });

    setCorrMerged(merged);
  }

  // ── Exportar maestro fusionado como JSON ──
  function downloadCorrectionReport() {
    if (!corrMerged) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(corrMerged, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `catalogo-actualizado-${dateStr}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="px-1 py-4">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#171433]">AutoQA</h1>
        <p className="text-sm text-gray-500 mt-1">Evalúa y corrige clasificaciones con Claude como juez externo.</p>
      </div>

      {/* ── Tabs principales ── */}
      <div className="flex gap-1 border-b border-slate-200 mb-5">
        {[
          { id: 'judge',      label: 'LLM-as-a-Judge' },
          { id: 'correccion', label: 'Corrección', badge: badRows.length > 0 ? badRows.length : null },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-all flex items-center gap-2 border-b-2 -mb-px ${
              tab === t.id
                ? 'border-indigo-600 text-indigo-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            {t.label}
            {t.badge && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-rose-500 text-white">
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab: LLM-as-a-Judge ── */}
      {tab === 'judge' && <div className="space-y-5">
          <div className="flex items-start gap-3 bg-indigo-50 border border-indigo-200 rounded-xl p-4">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0 text-white font-bold text-sm shadow-sm">J</div>
            <div>
              <p className="font-semibold text-indigo-900">LLM-as-a-Judge</p>
              <p className="text-xs mt-0.5 text-indigo-700">Claude evalúa cada clasificación como juez externo. Se calculan Precisión, Recall y F1 por categoría.</p>
            </div>
          </div>

          {/* Carga de archivos */}
          <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm space-y-4">
            <h3 className="font-semibold text-gray-800">Configuración</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">JSON de categorías (opcional — para pasar definiciones a los jueces)</label>
                <FileDropzone
                  accept=".json" maxMB={MAX_JSON_MB} hint="definiciones de categorías"
                  fileName={judgeModelLabel} detail={judgeModel ? `${Object.keys(judgeModel).length} categorías` : ''}
                  onFile={handleJudgeModelFile} onReject={setJudgeError} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Archivo etiquetado (CSV / Excel) <span className="text-red-400">*</span></label>
                <FileDropzone
                  accept=".csv,.xlsx" maxMB={MAX_DATOS_MB} hint="resultados ya etiquetados"
                  fileName={judgeDataFile} detail={judgeDataFile ? `${judgeDataRows.length.toLocaleString('es-CL')} filas` : ''}
                  onFile={handleJudgeDataFile} onReject={setJudgeError} />
              </div>
            </div>

            {judgeColumns.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-gray-100">
                {[
                  { label: 'Columna texto', value: judgeTextCol, setter: setJudgeTextCol, required: true },
                  { label: 'Columna categoría asignada', value: judgePredCol, setter: setJudgePredCol, required: true },
                  { label: 'Columna justificación (opcional)', value: judgeJustCol, setter: setJudgeJustCol, required: false },
                ].map(({ label, value, setter, required }) => (
                  <label key={label} className="flex flex-col gap-1 text-xs text-gray-600">
                    {label}{required && <span className="text-red-400 inline">*</span>}
                    <select value={value} onChange={e => setter(e.target.value)}
                      className={`border rounded-lg px-2 py-1.5 text-sm text-gray-700 focus:outline-none ${required && !value ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
                      <option value="">-- Selecciona --</option>
                      {judgeColumns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            )}

            {judgeDataRows.length > 0 && judgeTextCol && judgePredCol && (
              <div className="flex items-center gap-3 pt-2">
                <button onClick={runJudge} disabled={judgeRunning}
                  className={`px-5 py-2 rounded-lg text-sm font-semibold text-white shadow-sm transition-all ${judgeRunning ? 'bg-slate-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98]'}`}>
                  {judgeRunning ? `Evaluando… ${judgeProgress}%` : `Evaluar ${judgeDataRows.length} registros`}
                </button>
                {judgeResults.length > 0 && !judgeRunning && (
                  <button onClick={downloadJudgeReport}
                    className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-sm transition-colors">
                    Exportar Excel
                  </button>
                )}
              </div>
            )}

            {judgeRunning && (
              <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                <div className="h-full bg-indigo-500 rounded-full transition-all duration-300" style={{ width: `${judgeProgress}%` }} />
              </div>
            )}
            {judgeError && <p className="text-xs text-red-600">{judgeError}</p>}
          </div>

          {/* Métricas globales */}
          {judgeMetrics && (
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="font-semibold text-gray-800">Métricas</h3>
                <div className="flex gap-3 text-xs">
                  <span className="px-3 py-1 bg-violet-50 text-violet-700 rounded-full font-semibold">Macro F1: {(judgeMetrics.macroF1 * 100).toFixed(1)}%</span>
                  <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full font-semibold">Accuracy: {(judgeMetrics.accuracy * 100).toFixed(1)}%</span>
                  <span className="px-3 py-1 bg-gray-50 text-gray-600 rounded-full">{judgeMetrics.total} registros</span>
                </div>
              </div>
              <div className="overflow-auto" style={{ maxHeight: 400 }}>
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Código</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Categoría</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500">Total</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500">Precisión</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500">Recall</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500">F1</th>
                    </tr>
                  </thead>
                  <tbody>
                    {judgeMetrics.items.map((c, i) => (
                      <tr key={c.code} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                        <td className="px-3 py-2 font-mono text-xs text-gray-400">{c.code}</td>
                        <td className="px-3 py-2 text-gray-700 text-xs">{String(c.label).split(' - ').slice(1).join(' - ') || c.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">{c.total}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium" style={{ color: c.precision >= 0.8 ? '#10b981' : c.precision >= 0.5 ? '#f59e0b' : '#ef4444' }}>{(c.precision * 100).toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium" style={{ color: c.recall >= 0.8 ? '#10b981' : c.recall >= 0.5 ? '#f59e0b' : '#ef4444' }}>{(c.recall * 100).toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold" style={{ color: c.f1 >= 0.8 ? '#10b981' : c.f1 >= 0.5 ? '#f59e0b' : '#ef4444' }}>{(c.f1 * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tabla de votos por fila */}
          {judgeResults.length > 0 && (
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <h3 className="font-semibold text-gray-800">Votos por registro</h3>
              </div>
              <div className="overflow-auto" style={{ maxHeight: 500 }}>
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-400 w-8">#</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Texto</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Categoría</th>
                      <th className="px-3 py-2 text-center text-xs font-semibold text-gray-500">Claude</th>
                      <th className="px-3 py-2 text-center text-xs font-semibold text-blue-500">Gemini</th>
                      <th className="px-3 py-2 text-center text-xs font-semibold text-gray-500">Veredicto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {judgeResults.map((r, i) => {
                      const votes = r._judgeVotes || [];
                      const getVote = s => votes.find(v => v.source === s);
                      const renderVote = (source) => {
                        const v = getVote(source);
                        if (!v) return <span className="text-gray-200 text-xs">—</span>;
                        if (v.error) return <span className="text-gray-300 text-xs cursor-help" title={v.error}>—</span>;
                        return <span className={`inline-flex w-5 h-5 rounded-full text-xs font-bold items-center justify-center ${v.acuerdo ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`} title={v.razon}>{v.acuerdo ? '✓' : '✗'}</span>;
                      };
                      const requiresReview = r._judgeConsensus === null;
                      return (
                        <tr key={i} className={requiresReview ? 'bg-amber-50' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                          <td className="px-3 py-2 text-xs text-gray-300 text-right tabular-nums">{i+1}</td>
                          <td className="px-3 py-2 text-xs text-gray-700 max-w-xs truncate" title={String(r[judgeTextCol] || '')}>{String(r[judgeTextCol] || '').slice(0, 80)}{String(r[judgeTextCol] || '').length > 80 ? '…' : ''}</td>
                          <td className="px-3 py-2 text-xs text-gray-600 font-mono">{String(r[judgePredCol] || '').split(' - ')[0]}</td>
                          <td className="px-3 py-2 text-center">{renderVote('claude')}</td>
                          <td className="px-3 py-2 text-center">{renderVote('gemini')}</td>
                          <td className="px-3 py-2 text-center">
                            {r._judgeConsensus === true  && <span className="text-xs font-semibold text-green-600">Correcto</span>}
                            {r._judgeConsensus === false && <span className="text-xs font-semibold text-red-500">Revisar</span>}
                            {r._judgeConsensus === null  && <span className="text-xs font-semibold text-amber-600">Desacuerdo</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

      </div>}

      {/* ── Tab: Corrección ── */}
      {tab === 'correccion' && (
          <div className="space-y-5">

          {/* Banner descriptivo */}
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center shrink-0 text-white font-bold text-sm shadow-sm">C</div>
            <div>
              <p className="font-semibold text-amber-900">Corrección de datos</p>
              <p className="text-xs mt-0.5 text-amber-700">Carga un archivo con los resultados del etiquetado (CSV o XLSX), selecciona las columnas y elige el modo de corrección.</p>
            </div>
          </div>

          {/* ── Carga de archivo ── */}
          <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm space-y-4">
            <h3 className="font-semibold text-gray-800">Archivo de resultados</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Archivo de etiquetado (CSV o XLSX)</label>
                <FileDropzone
                  accept=".csv,.xlsx" maxMB={MAX_DATOS_MB} hint="resultados del etiquetado"
                  fileName={corrFileName} detail={corrFileName ? `${corrFileRows.length.toLocaleString('es-CL')} filas` : ''}
                  onFile={handleCorrFile} onReject={(m) => alert(m)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">JSON de catálogo (opcional — para definiciones)</label>
                <FileDropzone
                  accept=".json" maxMB={MAX_JSON_MB} hint="definiciones, opcional"
                  fileName={corrCatalogJson ? 'catálogo cargado' : ''}
                  detail={corrCatalogJson ? `${Object.keys(corrCatalogJson).length} categorías` : ''}
                  onFile={handleCorrCatalogFile} onReject={(m) => alert(m)} />
              </div>
            </div>

            {/* Selectores de columnas — solo cuando hay archivo */}
            {corrFileColumns.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-gray-100">
                {[
                  { label: 'Columna de texto / mensaje', value: corrTextCol, setter: setCorrTextCol },
                  { label: 'Columna de categoría asignada', value: corrCatCol, setter: setCorrCatCol },
                  { label: 'Columna de veredicto (filtro "No")', value: corrVerdictCol, setter: setCorrVerdictCol, optional: true },
                ].map(({ label, value, setter, optional }) => (
                  <div key={label}>
                    <label className="block text-xs font-medium text-gray-500 mb-1">{label}{optional && <span className="ml-1 text-gray-300">opcional</span>}</label>
                    <select value={value} onChange={e => setter(e.target.value)}
                      className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-amber-300">
                      <option value="">— seleccionar —</option>
                      {corrFileColumns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}

            {/* Resumen de filas a corregir */}
            {corrFileRows.length > 0 && corrTextCol && corrCatCol && (
              <div className="flex items-center gap-2 text-xs text-gray-500 pt-1">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100 font-semibold">
                  {corrBadRows.length} filas a corregir
                </span>
                {corrVerdictCol
                  ? <span>filtradas por veredicto "No" en <strong>{corrVerdictCol}</strong></span>
                  : <span>sin filtro de veredicto — se procesarán todas las filas</span>}
              </div>
            )}

            {/* Fallback: mostrar info de judge si no hay archivo propio */}
            {corrFileRows.length === 0 && badRows.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                <span>Usando {badRows.length} filas con veredicto "Revisar" del Judge ejecutado en esta sesión.</span>
              </div>
            )}
            {corrFileRows.length === 0 && badRows.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                <span>Carga un archivo o ejecuta el LLM-as-a-Judge primero para tener datos a corregir.</span>
              </div>
            )}
          </div>

          {/* ── Panel de corrección (solo cuando hay filas disponibles) ── */}
          {corrBadRows.length > 0 && (
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-gray-800">Redefinir categorías</h3>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {corrBadRows.length} mensaje{corrBadRows.length !== 1 ? 's' : ''} mal clasificados · {(() => { const cats = new Set(corrBadRows.map(r => String(r[corrEffCatCol] || ''))); return cats.size; })()} categorías a revisar
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={runCorrection}
                    disabled={corrRunning}
                    className={`px-4 py-1.5 rounded-lg text-xs font-semibold text-white shadow-sm transition-all ${corrRunning ? 'bg-slate-400 cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-600 active:scale-[0.98]'}`}
                  >
                    {corrRunning ? `Procesando… ${corrProgress}%` : 'Generar redefiniciones'}
                  </button>
                </div>
              </div>

              {corrRunning && (
                <div className="px-5 py-3">
                  <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                    <div className="h-full bg-amber-500 rounded-full transition-all duration-300" style={{ width: `${corrProgress}%` }} />
                  </div>
                </div>
              )}

              {/* ── Redefiniciones por categoría ── */}
              {corrRedefine.length > 0 && (
                <>
                <div className="p-5 space-y-4 overflow-auto" style={{ maxHeight: 600 }}>
                  {/* Barra de acción masiva */}
                  <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                    <p className="text-xs text-slate-500">
                      {corrRedefine.filter(r => r.status === 'accepted').length} de {corrRedefine.length} aceptadas
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setCorrRedefine(prev => prev.map(r => ({ ...r, status: 'accepted' })))}
                        className="px-3 py-1 rounded-lg text-xs font-semibold bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 shadow-sm transition-colors"
                      >
                        Aceptar todas
                      </button>
                      <button
                        onClick={() => { setCorrRedefine(prev => prev.map(r => ({ ...r, status: 'pending' }))); setCorrMerged(null); }}
                        className="px-3 py-1 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 shadow-sm transition-colors"
                      >
                        Limpiar selección
                      </button>
                    </div>
                  </div>
                  {corrRedefine.map((r, i) => {
                    // Word-level diff
                    const origWords = (r.current_definition || '').split(/\s+/);
                    const suggWords = (r.suggested_definition || '').split(/\s+/);
                    const origSet = new Set(origWords);
                    const suggSet = new Set(suggWords);
                    const renderDiff = (words, otherSet, mode) =>
                      words.map((w, wi) => {
                        const inOther = otherSet.has(w);
                        const cls = !inOther
                          ? (mode === 'orig' ? 'bg-red-100 text-red-700 line-through rounded px-0.5' : 'bg-green-100 text-green-700 rounded px-0.5')
                          : 'text-gray-700';
                        return <span key={wi} className={cls}>{w} </span>;
                      });

                    const borderCls = r.status === 'accepted'
                      ? 'border-green-300'
                      : r.status === 'rejected'
                        ? 'border-red-200'
                        : 'border-gray-200';
                    return (
                      <div key={i} className={`border rounded-xl overflow-hidden ${borderCls}`}>
                        <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50 border-gray-100">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="min-w-0">
                              <span className="text-sm font-semibold text-gray-800">{r.category}</span>
                              <span className="ml-2 text-xs text-gray-400">{r.count} mensaje{r.count !== 1 ? 's' : ''} mal clasificados</span>
                            </div>
                          </div>
                          <div className="flex gap-1.5 shrink-0">
                            <button
                              onClick={() => setCorrItemStatus(i, r.status === 'accepted' ? 'pending' : 'accepted')}
                              className={`px-3 py-1 rounded-lg text-xs font-semibold shadow-sm transition-all ${r.status === 'accepted' ? 'bg-emerald-500 text-white ring-2 ring-emerald-200' : 'bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50'}`}
                            >Aceptar</button>
                            <button
                              onClick={() => setCorrItemStatus(i, r.status === 'rejected' ? 'pending' : 'rejected')}
                              className={`px-3 py-1 rounded-lg text-xs font-semibold shadow-sm transition-all ${r.status === 'rejected' ? 'bg-rose-500 text-white ring-2 ring-rose-200' : 'bg-white border border-rose-300 text-rose-600 hover:bg-rose-50'}`}
                            >Descartar</button>
                          </div>
                        </div>
                        {r.status === 'error'
                          ? <p className="px-4 py-3 text-xs text-red-500">{r.razon}</p>
                          : (
                            <div className="grid grid-cols-2 divide-x divide-gray-100">
                              <div className="p-4">
                                <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 mb-2">Original</p>
                                <p className="text-xs leading-relaxed">{renderDiff(origWords, suggSet, 'orig')}</p>
                              </div>
                              <div className="p-4">
                                <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 mb-2">Sugerida</p>
                                <textarea
                                  value={r.editValue}
                                  onChange={e => setCorrItemEdit(i, e.target.value)}
                                  rows={5}
                                  className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-300 resize-none mb-2"
                                />
                                {r.razon && <p className="text-[10px] text-gray-400 italic">{r.razon}</p>}
                              </div>
                            </div>
                          )
                        }
                      </div>
                    );
                  })}
                </div>
                {/* ── Footer: Unir + Exportar ── */}
                <CorrFooter
                  nAccepted={corrRedefine.filter(r => r.status === 'accepted').length}
                  hasCatalog={!!corrEffCatalog}
                  corrMerged={corrMerged}
                  onMerge={mergeToCatalog}
                  onExport={downloadCorrectionReport}
                />
                </>
              )}
            </div>
          )}
          </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-xl shadow-xl max-w-sm w-full mx-4">
            <h2 className="text-lg font-bold mb-2">Confirmar eliminación</h2>
            <p className="text-sm text-gray-600 mb-5">¿Seguro que quieres eliminar el modelo <strong>"{modelToDelete}"</strong>?</p>
            <div className="flex justify-end gap-3">
              <button onClick={cancelDelete}  className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-sm font-medium shadow-sm transition-colors">Cancelar</button>
              <button onClick={confirmDelete} className="px-4 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 text-sm font-semibold shadow-sm transition-colors">Eliminar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AutoQA;
