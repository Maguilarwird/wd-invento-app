// src/ui/archivos.js
// Reglas de los archivos de entrada, en un solo sitio.
//
// Antes cada módulo repetía su propia versión: el rechazo de .xls estaba
// escrito cinco veces con el mismo texto, y el límite de tamaño solo existía
// en dos de los cuatro módulos —10 MB en Levantamiento comprobado al elegir,
// 10 MB en Etiquetado comprobado recién al pulsar «Iniciar», y ninguno en
// OTBB ni AutoQA, que son los que manejan los archivos más grandes.
//
// Vive aparte de los componentes para que el fast-refresh de Vite siga
// funcionando en ellos (un archivo que exporta componentes no debería
// exportar también constantes).

/** Límite único para archivos de datos (CSV/XLSX). */
export const MAX_DATOS_MB = 25;

/** Los maestros de categorías son JSON de unas pocas decenas de KB. */
export const MAX_JSON_MB = 5;

/**
 * Comprueba un archivo contra el contrato de la zona de carga.
 * Devuelve `null` si es válido, o el mensaje de error si no lo es.
 *
 * Los mensajes dicen qué hacer, no solo qué falló: un usuario con un .xls
 * necesita saber que la salida es «guárdalo como .xlsx», no que el formato
 * no está soportado.
 */
export function validarArchivo(file, { accept = '.csv,.xlsx', maxMB = MAX_DATOS_MB } = {}) {
  if (!file) return null;
  const nombre = file.name.toLowerCase();

  if (nombre.endsWith('.xls')) {
    return 'Formato .xls (Excel 97-2003) no soportado. Ábrelo en Excel y guárdalo como .xlsx.';
  }

  const extensiones = accept.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (extensiones.length && !extensiones.some(ext => nombre.endsWith(ext))) {
    return `«${file.name}» no tiene un formato aceptado. Se admite ${extensiones.join(' o ')}.`;
  }

  if (file.size > maxMB * 1024 * 1024) {
    const pesa = (file.size / 1024 / 1024).toFixed(1);
    return `El archivo pesa ${pesa} MB y el máximo es ${maxMB} MB. `
      + 'Divide la muestra en partes y procesa una por vez.';
  }

  return null;
}

/** Llamadas al modelo para `filas` registros procesados en lotes de `lote`. */
export function estimarLlamadas(filas, lote) {
  if (!filas || !lote) return 0;
  return Math.ceil(filas / lote);
}

/** Formatea un conteo con separador de miles, en el locale de la app. */
export function formatearFilas(n) {
  return Number(n || 0).toLocaleString('es-CL');
}
