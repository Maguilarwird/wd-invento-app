// src/ui/FilePreflight.jsx
// "Qué va a pasar si pulso el botón", antes de gastar un token.
//
// Generaliza lo que OTBB ya hacía bien en modo conversación
// (`ThreadPreanalysisPanel` / `ExclusionPreanalysisPanel`): enseñar lo que se
// sabe del archivo por lectura local, antes de llamar al modelo. El resto de
// los módulos no tenía nada equivalente: se elegía una columna y se pulsaba
// «Procesar» sin saber cuántas filas había, cuántas llamadas costaría, ni que
// el texto sale hacia un proveedor externo.
//
// Recibe las cifras ya calculadas en lugar de calcularlas: cada módulo sabe
// cosas distintas de su archivo, y meter esa lógica aquí obligaría a inventar
// un modelo común que no existe.

export default function FilePreflight({
  /** [{ label, value }] — lo que este módulo sabe del archivo. */
  stats = [],
  /** Qué ocurrirá al ejecutar, en lenguaje llano. */
  note,
  /** Salvedad de esquema: falta una columna, se descartarán filas, etc. */
  warning,
  title = 'Antes de ejecutar',
  subtitle = 'Lectura local del archivo. Todavía no se ha enviado nada al modelo.',
}) {
  if (!stats.length) return null;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-semibold text-ink">{title}</p>
      <p className="text-[11px] text-ink-muted mt-0.5 mb-3">{subtitle}</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {stats.map(({ label, value }) => (
          <div key={label} className="rounded-lg bg-canvas px-3 py-2 min-w-0">
            <p className="text-[15px] font-semibold text-ink leading-tight tabular-nums truncate" title={String(value)}>
              {value}
            </p>
            <p className="text-[10px] uppercase tracking-wide text-ink-muted mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {note && <p className="text-[11px] text-ink-muted mt-3 leading-relaxed">{note}</p>}

      {warning && (
        <div className="flex items-start gap-2 mt-3 rounded-lg bg-amber-50 px-3 py-2">
          <span className="text-amber-600 text-xs leading-5">▲</span>
          <p className="text-[11px] text-amber-800 leading-relaxed">{warning}</p>
        </div>
      )}
    </div>
  );
}
