// src/ui/FileDropzone.jsx
// Zona de carga compartida por los cuatro módulos que ingieren datos.
//
// Sustituye al `<input type="file">` desnudo que había en Levantamiento,
// Etiquetado, AutoQA y OTBB. Aquel no declaraba los formatos (vivían en el
// atributo `accept`, invisible), no declaraba el tamaño máximo (en OTBB y
// AutoQA directamente no había), y solo confirmaba el nombre del archivo.
//
// La validación vive aquí a propósito: antes cada módulo repetía su propia
// versión —el rechazo de .xls estaba escrito cinco veces— y el límite de
// tamaño solo existía en dos de los cuatro, con criterios distintos.

import { useState } from 'react';

import { MAX_DATOS_MB, validarArchivo } from './archivos';

export default function FileDropzone({
  accept = '.csv,.xlsx',
  maxMB = MAX_DATOS_MB,
  /** Qué es una fila en este archivo, p. ej. "1 fila = 1 mensaje". */
  hint,
  file,
  /** Nombre recuperado de la caché cuando ya no hay objeto `File`. */
  fileName,
  /** Confirmación de lo que se leyó: "2.418 filas", "12 categorías". */
  detail,
  parsing = false,
  disabled = false,
  error = false,
  /** Ruta a una plantilla de ejemplo, si el módulo tiene una. */
  templateHref,
  templateLabel = 'Descargar plantilla de ejemplo',
  onFile,
  onReject,
}) {
  const [dragging, setDragging] = useState(false);
  const cargado = Boolean(file || fileName);

  const aceptar = (f) => {
    if (!f) return;
    const problema = validarArchivo(f, { accept, maxMB });
    if (problema) {
      onReject?.(problema);
      return;
    }
    onFile?.(f);
  };

  const borde = error ? 'border-rose-300 bg-rose-50/40'
    : dragging ? 'border-accent bg-accent/10'
    : cargado ? 'border-accent/50 bg-accent/5'
    : 'border-line bg-canvas/40 hover:border-navy/30';

  const formatos = accept.split(',').map(e => e.trim().replace('.', '').toUpperCase()).join(' o ');

  return (
    <div>
      <label
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) aceptar(e.dataTransfer.files?.[0]);
        }}
        className={`block rounded-xl border-2 border-dashed px-4 py-3 text-center transition-colors
          focus-within:ring-2 focus-within:ring-accent/40
          ${borde} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        {parsing ? (
          <p className="text-xs font-medium text-ink">Leyendo el archivo…</p>
        ) : cargado ? (
          <>
            <p className="text-xs font-semibold text-ink truncate">{file?.name || fileName}</p>
            <p className="text-[11px] text-ink-muted mt-0.5">
              {detail ? `${detail} · ` : ''}Arrastra otro archivo para reemplazarlo
            </p>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-ink">Arrastra tu archivo o haz clic para elegirlo</p>
            <p className="text-[11px] text-ink-muted mt-0.5">
              {formatos} · máx. {maxMB} MB{hint ? ` · ${hint}` : ''}
            </p>
          </>
        )}
        <input
          type="file"
          accept={accept}
          className="sr-only"
          disabled={disabled}
          onChange={(e) => {
            aceptar(e.target.files?.[0]);
            // Permite volver a elegir el mismo archivo tras corregirlo.
            e.target.value = '';
          }}
        />
      </label>

      {templateHref && !cargado && (
        <a
          href={templateHref}
          download
          className="inline-block mt-1.5 text-[11px] font-medium text-emerald-700 hover:underline"
        >
          ↓ {templateLabel}
        </a>
      )}
    </div>
  );
}
