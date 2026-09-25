import { useState, useEffect, useMemo, useRef, useCallback } from 'react';

// ── Parsea nombre y definición de una etiqueta con formato "Nombre [def]" ─────
function parseLabel(label) {
  const str = String(label ?? '');
  const match = str.match(/^(.*?)\s*\[(.+)\]\s*$/s);
  if (!match) return { name: str.trim(), definition: null };
  return { name: match[1].trim(), definition: match[2].trim() };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const W = 1400;
const H = 720;

const CAT_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6',
  '#f43f5e', '#3b82f6', '#a855f7', '#22d3ee', '#fb923c',
];

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ── Pan / Zoom hook ───────────────────────────────────────────────────────────
function usePanZoom() {
  const svgRef    = useRef(null);
  const txRef     = useRef({ x: 0, y: 0, scale: 1 });
  const [tx, setTx] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const dragging  = useRef(false);

  const applyTx = useCallback((fn) => {
    const next = fn(txRef.current);
    txRef.current = next;
    setTx({ ...next });
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx   = (e.clientX - rect.left) / rect.width  * W;
      const my   = (e.clientY - rect.top)  / rect.height * H;
      const fac  = e.deltaY > 0 ? 0.88 : 1.14;
      applyTx(t => {
        const ns = clamp(t.scale * fac, 0.15, 8);
        const sf = ns / t.scale;
        return { scale: ns, x: mx - sf * (mx - t.x), y: my - sf * (my - t.y) };
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [applyTx]);

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragging.current = true; setIsDragging(true);
    lastMouse.current = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }, []);

  const onMouseMove = useCallback((e) => {
    if (!dragging.current) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = (e.clientX - lastMouse.current.x) / rect.width  * W;
    const dy = (e.clientY - lastMouse.current.y) / rect.height * H;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    applyTx(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
  }, [applyTx]);

  const stopDrag = useCallback(() => { dragging.current = false; setIsDragging(false); }, []);
  const reset    = useCallback(() => { txRef.current = { x: 0, y: 0, scale: 1 }; setTx({ x: 0, y: 0, scale: 1 }); }, []);

  return {
    svgRef,
    gTransform: `translate(${tx.x} ${tx.y}) scale(${tx.scale})`,
    isDragging,
    isDefault: tx.x === 0 && tx.y === 0 && tx.scale === 1,
    reset,
    svgHandlers: { onMouseDown, onMouseMove, onMouseUp: stopDrag, onMouseLeave: stopDrag },
  };
}

// ── Layout ────────────────────────────────────────────────────────────────────
function ringPositions(n, catR, subR) {
  if (n === 0) return [];
  if (n === 1) return [{ dx: 0, dy: 0 }];
  const gap = subR * 2.3;
  const out = [];
  let ring = 0, placed = 0;
  while (placed < n) {
    if (ring === 0) { out.push({ dx: 0, dy: 0 }); placed++; ring++; continue; }
    const ringR = gap * ring;
    if (ringR + subR > catR * 0.88) break;
    const spots  = Math.max(1, Math.floor((2 * Math.PI * ringR) / gap));
    const offset = ring % 2 === 0 ? Math.PI / spots : 0;
    for (let i = 0; i < spots && placed < n; i++) {
      const a = (2 * Math.PI * i / spots) + offset;
      out.push({ dx: ringR * Math.cos(a), dy: ringR * Math.sin(a) });
      placed++;
    }
    ring++;
  }
  while (placed < n) {
    const a = placed * 2.4;
    const r = catR * 0.85 + (placed - out.length) * subR * 0.5;
    out.push({ dx: r * Math.cos(a), dy: r * Math.sin(a) });
    placed++;
  }
  return out;
}

function settleCats(initial) {
  let pos = initial.map(c => ({ x: c.ox, y: c.oy, vx: 0, vy: 0 }));
  for (let iter = 0; iter < 180; iter++) {
    for (let i = 0; i < pos.length; i++) {
      pos[i].vx += (initial[i].ox - pos[i].x) * 0.04;
      pos[i].vy += (initial[i].oy - pos[i].y) * 0.04;
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        const d  = Math.sqrt(dx * dx + dy * dy) || 1;
        const mn = initial[i].r + initial[j].r + 14;
        if (d < mn) {
          const f = ((mn - d) / d) * 0.55;
          pos[i].vx += dx * f; pos[i].vy += dy * f;
          pos[j].vx -= dx * f; pos[j].vy -= dy * f;
        }
      }
      pos[i].vx *= 0.84; pos[i].vy *= 0.84;
      pos[i].x = clamp(pos[i].x + pos[i].vx, initial[i].r + 12, W - initial[i].r - 12);
      pos[i].y = clamp(pos[i].y + pos[i].vy, initial[i].r + 56, H - initial[i].r - 16);
    }
  }
  return pos;
}

function buildLayout(hierarchy, flat) {
  const catKeys = Object.keys(hierarchy);
  const N       = catKeys.length;
  const cx = W / 2, cy = H / 2 + 22;
  const ringR   = Math.min(W, H) * 0.31;
  const maxSubs = Math.max(...catKeys.map(c => hierarchy[c].length), 1);
  const baseR   = Math.max(38, Math.min(80, (Math.min(W, H) * 0.18) / Math.sqrt(maxSubs)));

  const initial = catKeys.map((cat, i) => {
    const angle = (2 * Math.PI * i / N) - Math.PI / 2;
    const nSubs = hierarchy[cat].length;
    return {
      cat, index: i,
      color: CAT_COLORS[i % CAT_COLORS.length],
      r: Math.max(36, baseR * Math.sqrt(nSubs)),
      nSubs,
      ox: cx + ringR * Math.cos(angle),
      oy: cy + ringR * Math.sin(angle),
    };
  });

  const settled     = settleCats(initial);
  const labelToCode = {};
  Object.entries(flat).forEach(([code, label]) => { labelToCode[label] = code; });

  const categories = initial.map((c, i) => ({ ...c, x: settled[i].x, y: settled[i].y }));

  const subcategories = categories.flatMap(cat => {
    const subs  = hierarchy[cat.cat] || [];
    const subR  = Math.max(9, Math.min(17, cat.r / (Math.sqrt(subs.length) + 1.2)));
    const positions = ringPositions(subs.length, cat.r, subR);
    return subs.map((label, si) => ({
      label,
      code:     labelToCode[label] || `?${si}`,
      cat:      cat.cat,
      catIndex: cat.index,
      color:    cat.color,
      x: cat.x + (positions[si]?.dx ?? 0),
      y: cat.y + (positions[si]?.dy ?? 0),
      r: subR,
    }));
  });

  return { categories, subcategories };
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function Tooltip({ tooltip }) {
  if (!tooltip) return null;
  return (
    <div
      className="fixed z-50 pointer-events-none bg-gray-900 text-white text-xs px-2.5 py-1.5 rounded-lg shadow-lg max-w-xs"
      style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}
    >
      {tooltip.cat  && <p className="text-gray-400 text-[10px] mb-0.5">{tooltip.cat}</p>}
      <p className="font-medium leading-snug">{parseLabel(tooltip.label).name}</p>
      {tooltip.code && <p className="text-gray-400 text-[10px] mt-0.5">{tooltip.code}</p>}
      {parseLabel(tooltip.label).definition && (
        <p className="text-gray-300 text-[10px] mt-1 leading-relaxed border-t border-gray-600 pt-1">{parseLabel(tooltip.label).definition}</p>
      )}
    </div>
  );
}

// ── Bubble map ────────────────────────────────────────────────────────────────
function BubbleMap({ hierarchy, flat }) {
  const [tooltip, setTooltip] = useState(null);
  const [visible, setVisible] = useState(false);
  const { svgRef, gTransform, isDragging, isDefault, reset, svgHandlers } = usePanZoom();

  const { categories, subcategories } = useMemo(
    () => buildLayout(hierarchy, flat),
    [Object.keys(hierarchy).sort().join(',')]
  );

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  const labelFontSize = Math.max(11, Math.min(15, 170 / Math.max(categories.length, 1)));

  return (
    <>
      <div className="relative rounded-xl border border-gray-100 overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', display: 'block', cursor: isDragging ? 'grabbing' : 'grab', userSelect: 'none' }}
          className="bg-gradient-to-br from-slate-50 to-white"
          {...svgHandlers}
        >
          <g transform={gTransform}>
            {categories.map(cat => (
              <g key={cat.cat}>
                <circle
                  cx={cat.x} cy={cat.y} r={cat.r}
                  fill={cat.color} fillOpacity={0.11}
                  stroke={cat.color} strokeOpacity={0.28}
                  strokeWidth={1.5} strokeDasharray="5 3"
                />
                <text
                  x={cat.x} y={cat.y - cat.r - 8}
                  textAnchor="middle"
                  style={{ fontSize: labelFontSize, fontWeight: 700, fill: cat.color, fontFamily: 'system-ui', pointerEvents: 'none' }}
                >
                  {cat.cat}
                </text>
              </g>
            ))}

            {subcategories.map((node, i) => (
              <circle
                key={node.code || i}
                cx={node.x} cy={node.y} r={node.r}
                fill={node.color}
                fillOpacity={visible ? 0.85 : 0}
                stroke="white" strokeWidth={1.5}
                style={{ transition: `fill-opacity 0.5s ease ${i * 8}ms`, cursor: isDragging ? 'grabbing' : 'pointer' }}
                onMouseEnter={(e) => { if (!isDragging) setTooltip({ x: e.clientX, y: e.clientY, label: node.label, code: node.code, cat: node.cat }); }}
                onMouseLeave={() => setTooltip(null)}
              />
            ))}
          </g>
        </svg>

        <div className="absolute top-2 right-2">
          {!isDefault && (
            <button onClick={reset} className="text-xs px-2 py-1 bg-white/90 backdrop-blur-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-white shadow-sm">
              ↺ Restablecer
            </button>
          )}
        </div>
        <p className="absolute bottom-2 left-0 right-0 text-center text-[10px] text-gray-400 pointer-events-none select-none">
          Arrastra para mover · Rueda del ratón para zoom
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {categories.map(cat => (
          <span key={cat.cat} className="flex items-center gap-1.5 text-xs text-gray-700">
            <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} />
            {cat.cat}
          </span>
        ))}
      </div>

      <Tooltip tooltip={tooltip} />
    </>
  );
}

// ── Celda editable ────────────────────────────────────────────────────────────
function EditCell({ value, onSave, mono, placeholder }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft.trim() && draft.trim() !== value) onSave(draft.trim()); }}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setDraft(value); e.target.blur(); } }}
      className={`w-full px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 focus:outline-none focus:border-amber-400 focus:bg-white transition-colors ${mono ? 'font-mono text-xs text-gray-400' : 'text-sm text-gray-800'}`}
    />
  );
}

// ── Table view ────────────────────────────────────────────────────────────────
function TableView({ hierarchy, flat, onUpdateSub, onUpdateCat, onDeleteSub, onDeleteCat, editMode }) {
  const [filter,     setFilter]     = useState('');
  const [confirmCat, setConfirmCat] = useState(null);

  const rows = useMemo(() => {
    const out = [];
    Object.entries(hierarchy).forEach(([cat, subs]) => {
      subs.forEach(label => {
        const code = Object.entries(flat).find(([, l]) => l === label)?.[0] || '';
        out.push({ code, cat, label });
      });
    });
    return out.sort((a, b) => a.code.localeCompare(b.code));
  }, [hierarchy, flat]);

  const filtered = filter.trim()
    ? rows.filter(r => [r.code, r.label, r.cat].some(v => v.toLowerCase().includes(filter.toLowerCase())))
    : rows;

  // Primera fila de cada categoría (para el botón "eliminar grupo")
  const catFirstIdx = useMemo(() => {
    const seen = {};
    filtered.forEach((row, i) => { if (!(row.cat in seen)) seen[row.cat] = i; });
    return seen;
  }, [filtered]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 px-5">
        <input
          type="text"
          placeholder="Buscar código, subcategoría o categoría…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400"
        />
        <span className="text-xs text-gray-400 shrink-0">{filtered.length} de {rows.length}</span>
      </div>

      {editMode && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3 mx-5">
          ✏ Modo edición activo — edita cualquier celda. <strong>×</strong> en la fila elimina esa subcategoría.
          Para eliminar una categoría completa usa <strong>🗑 grupo</strong> en la primera fila del grupo.
        </p>
      )}

      {/* Confirmación eliminar categoría completa */}
      {confirmCat && (
        <div className="mb-3 flex items-center gap-3 px-4 py-2.5 bg-red-50 border-y border-red-200">
          <span className="text-xs text-red-700 flex-1">
            ¿Eliminar la categoría <strong>"{confirmCat}"</strong> y <em>todas</em> sus subcategorías?
          </span>
          <button
            onClick={() => { onDeleteCat(confirmCat); setConfirmCat(null); }}
            className="text-xs px-3 py-1 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            Eliminar grupo
          </button>
          <button
            onClick={() => setConfirmCat(null)}
            className="text-xs px-3 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Cancelar
          </button>
        </div>
      )}

      <div className="overflow-auto max-h-[640px] border-t border-gray-100">
        <table className="text-sm border-collapse" style={{ minWidth: 1100, width: '100%' }}>
          <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 whitespace-nowrap" style={{ width: 90 }}>Código</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500" style={{ width: 220 }}>Subcategoría</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500" style={{ minWidth: 380 }}>Definición sugerida</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500" style={{ minWidth: 200 }}>Categoría</th>
              {editMode && <th className="px-2 py-2" style={{ width: 32 }} />}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, i) => {
              const isFirstOfCat = catFirstIdx[row.cat] === i;
              const { name, definition } = parseLabel(row.label);
              return (
                <tr key={row.code} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                  <td className="px-3 py-2 font-mono text-xs text-gray-400 whitespace-nowrap align-top">{row.code}</td>
                  <td className="px-2 py-2 align-top">
                    {editMode
                      ? <EditCell value={row.label} onSave={v => onUpdateSub(row.code, row.label, row.cat, v)} />
                      : <span className="text-gray-800 text-xs font-medium leading-snug">{name}</span>
                    }
                  </td>
                  <td className="px-2 py-2 align-top">
                    {definition
                      ? <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap">{definition}</p>
                      : <span className="text-gray-300 text-xs">—</span>
                    }
                  </td>
                  <td className="px-2 py-2 align-top">
                    {editMode ? (
                      <div className="flex items-center gap-1">
                        <EditCell value={row.cat} mono onSave={v => onUpdateCat(row.cat, v)} />
                        {isFirstOfCat && (
                          <button
                            onClick={() => setConfirmCat(row.cat)}
                            title={`Eliminar categoría "${row.cat}" completa`}
                            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-red-200 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors whitespace-nowrap"
                          >
                            🗑 grupo
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-500">{row.cat}</span>
                    )}
                  </td>
                  {editMode && (
                    <td className="px-1 py-1 text-center align-top">
                      <button
                        onClick={() => onDeleteSub(row.code, row.label, row.cat)}
                        title={`Eliminar subcategoría "${row.label}"`}
                        className="w-5 h-5 flex items-center justify-center rounded text-red-300 hover:text-red-600 hover:bg-red-50 transition-colors text-base leading-none mx-auto"
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main ResultsView ──────────────────────────────────────────────────────────
export default function ResultsView({ flat, hierarchy, sampleSize, generatedDateStr }) {
  const [tab,      setTab]      = useState('mapa');
  const [editMode, setEditMode] = useState(false);

  // Editable copies of flat and hierarchy
  const [editFlat, setEditFlat] = useState(() => ({ ...flat }));
  const [editHier, setEditHier] = useState(() => {
    const h = {};
    Object.entries(hierarchy).forEach(([cat, subs]) => { h[cat] = [...subs]; });
    return h;
  });

  const hasEdits = useMemo(() => {
    return JSON.stringify(editFlat) !== JSON.stringify(flat) ||
           JSON.stringify(editHier) !== JSON.stringify(hierarchy);
  }, [editFlat, editHier, flat, hierarchy]);

  function updateSubLabel(code, oldLabel, catName, newLabel) {
    setEditFlat(f => ({ ...f, [code]: newLabel }));
    setEditHier(h => ({ ...h, [catName]: h[catName].map(s => s === oldLabel ? newLabel : s) }));
  }

  function updateCatName(oldCat, newCat) {
    if (newCat in editHier && newCat !== oldCat) return; // no duplicates
    setEditHier(h => {
      const next = {};
      Object.entries(h).forEach(([k, v]) => { next[k === oldCat ? newCat : k] = v; });
      return next;
    });
  }

  function deleteSubcategory(code, label, catName) {
    setEditFlat(f => {
      const next = { ...f };
      delete next[code];
      return next;
    });
    setEditHier(h => {
      const next = { ...h };
      const remaining = (next[catName] || []).filter(l => l !== label);
      if (remaining.length === 0) {
        delete next[catName]; // auto-remove category if it becomes empty
      } else {
        next[catName] = remaining;
      }
      return next;
    });
  }

  function deleteCategory(catName) {
    const labelsToRemove = new Set(editHier[catName] || []);
    setEditHier(h => {
      const next = { ...h };
      delete next[catName];
      return next;
    });
    setEditFlat(f => {
      const next = { ...f };
      Object.entries(next).forEach(([code, label]) => {
        if (labelsToRemove.has(label)) delete next[code];
      });
      return next;
    });
  }

  function resetEdits() {
    setEditFlat({ ...flat });
    const h = {};
    Object.entries(hierarchy).forEach(([cat, subs]) => { h[cat] = [...subs]; });
    setEditHier(h);
  }

  const dateStr = generatedDateStr || new Date().toISOString().slice(0, 10);

  function downloadJson() {
    // Exporta {code: {name, definition}} separando nombre y definición
    const payload = {};
    Object.entries(editFlat).forEach(([code, label]) => {
      const { name, definition } = parseLabel(label);
      payload[code] = definition ? { name, definition } : name;
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `categorias-especificas-${dateStr}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  // JSON jerarquía: {CategoríaPrincipal: {WMAnnn: "descripción", ...}}
  // Construido a partir de los datos editables (hierarchy + flat), sin LLM.
  function downloadHierarchyJson() {
    // Invertimos flat para obtener {label → code}
    const labelToCode = {};
    Object.entries(editFlat).forEach(([code, label]) => { labelToCode[label] = code; });

    const payload = {};
    Object.entries(editHier).forEach(([cat, labels]) => {
      const entries = {};
      labels.forEach(label => {
        const code = labelToCode[label];
        if (!code) return;
        const { name, definition } = parseLabel(label);
        entries[code] = definition ? { name, definition } : name;
      });
      if (Object.keys(entries).length > 0) payload[cat] = entries;
    });

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `categorias-jerarquicas-${dateStr}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  const totalSubs = Object.keys(editFlat).length;
  const totalCats = Object.keys(editHier).length;

  const tabs = [
    { id: 'mapa',  label: '🗺 Mapa de clusters' },
    { id: 'tabla', label: '📋 Tabla' },
  ];

  return (
    <div className="mt-6 bg-white rounded-xl shadow-md border border-gray-100 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-slate-50 to-white">
        <div className="flex justify-between items-start gap-3">
          <div>
            <h3 className="text-base font-bold text-[#171433]">Resultados del levantamiento</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {totalCats} categorías · {totalSubs} subcategorías
              {sampleSize > 0 && <span className="text-gray-400"> · {sampleSize.toLocaleString()} registros procesados</span>}
            </p>
          </div>
          {/* Botones solo visibles en la pestaña Tabla */}
          {tab === 'tabla' && (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {hasEdits && (
                <button
                  onClick={resetEdits}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
                >
                  ↺ Deshacer cambios
                </button>
              )}
              <button
                onClick={() => setEditMode(e => !e)}
                className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                  editMode
                    ? 'border-amber-400 bg-amber-100 text-amber-800 hover:bg-amber-200'
                    : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
                }`}
              >
                {editMode ? '✓ Finalizar edición' : '✏ Editar'}
              </button>
              <button
                onClick={downloadJson}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                title="Descarga {WMAnnn: descripción, ...}"
              >
                ⬇ JSON específicas{hasEdits ? ' (editado)' : ''}
              </button>
              <button
                onClick={downloadHierarchyJson}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors"
                title="Descarga {CategoríaPrincipal: {WMAnnn: descripción, ...}}"
              >
                ⬇ JSON jerárquico
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
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

      {/* Content */}
      <div className={tab === 'tabla' ? 'py-4 px-0' : 'p-5'}>
        {tab === 'mapa'  && <BubbleMap hierarchy={editHier} flat={editFlat} />}
        {tab === 'tabla' && (
          <TableView
            hierarchy={editHier}
            flat={editFlat}
            editMode={editMode}
            onUpdateSub={updateSubLabel}
            onUpdateCat={updateCatName}
            onDeleteSub={deleteSubcategory}
            onDeleteCat={deleteCategory}
          />
        )}
      </div>
    </div>
  );
}
