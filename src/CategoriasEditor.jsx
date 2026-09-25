import { useEffect } from 'react';

export function parseCategoriasMaster(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('JSON inválido: revisa comas, comillas y llaves.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('El maestro debe ser un objeto { "WMA001": "nombre [definición]", ... }.');
  }

  const cleaned = {};
  for (const [code, name] of Object.entries(parsed)) {
    if (typeof name !== 'string') {
      throw new Error(`La categoría "${code}" debe tener un nombre en texto.`);
    }
    const trimmedCode = String(code).trim();
    const trimmedName = name.trim();
    if (!trimmedCode || !trimmedName) {
      throw new Error(`Hay una categoría vacía (${trimmedCode || 'sin código'}).`);
    }
    cleaned[trimmedCode] = trimmedName;
  }
  if (Object.keys(cleaned).length === 0) {
    throw new Error('El maestro no puede estar vacío.');
  }
  return cleaned;
}

export function stringifyCategoriasMaster(categorias) {
  return JSON.stringify(categorias, null, 2);
}

export default function CategoriasEditor({
  open,
  fileName,
  draft,
  error,
  dirty,
  savedCount,
  onChange,
  onSave,
  onDownload,
  onClose,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40"
        aria-label="Cerrar editor de categorías"
        onClick={onClose}
      />
      <div className="relative flex h-[min(88vh,820px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-base font-bold text-[#171433]">Maestro de categorías</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              {fileName || 'maestro.json'}
              {savedCount > 0 ? ` · ${savedCount} categorías listas para procesar` : ''}
              {dirty ? ' · cambios sin guardar' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-lg leading-none text-slate-400 hover:bg-slate-50 hover:text-slate-700"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 px-5 py-4">
          <textarea
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 font-mono text-xs leading-5 text-slate-800 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
          />
        </div>

        {error && (
          <div className="mx-5 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
          <p className="text-xs text-slate-500">
            Guarda para usar este JSON en el etiquetado. Cerrar sin guardar deja la última versión válida.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onDownload}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              Descargar
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              Cerrar
            </button>
            <button
              type="button"
              onClick={onSave}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              Guardar para procesar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
