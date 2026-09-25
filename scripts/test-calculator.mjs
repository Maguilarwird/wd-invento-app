import {
  estimateEtiquetado,
  estimateLevantamiento,
  estimateAutoqa,
  estimateAutoqaCorreccion,
  estimateOtbb,
} from '../calculator-service.js';
import { getBancaMaster } from '../catalog-service.js';

const e = estimateEtiquetado({
  categoriasJson: JSON.stringify({ WMA001: 'A', WMA002: 'B' }),
  preset: 'correo',
  taggingMode: 'single',
  numMessages: 1000,
});
console.log('etiquetado usdPerMessage', e.usdPerMessage, 'usdTotalRun', e.usdTotalRun, 'totalTokens', e.totalTokens);

const l = estimateLevantamiento({ numMensajes: 500, medium: 'CORREO' });
console.log('levantamiento usdTotalRun', l.usdTotalRun, 'totalTokens', l.totalTokens);

const a = estimateAutoqa({
  numMessages: 1000,
  preset: 'correo',
  disagreementRate: 0.2,
  categoriasJson: JSON.stringify({
    WMA001: 'Consulta [El cliente pregunta por un producto. Ejemplo: "tienen stock?".]',
    WMA002: 'Reclamo [El cliente expresa molestia por el servicio recibido.]',
  }),
});
console.log('autoqa judge usdTotal', a.usdTotal, 'avgDefChars', a.avgDefChars, 'defSource', a.defSource);

const c = estimateAutoqaCorreccion({ numCategories: 25, examplesPerCategory: 8 });
console.log('correccion usdTotal', c.usdTotal, 'totalTokens', c.totalTokens);

const t = estimateLevantamiento({ numMensajes: 1000, medium: 'CORREO', unit: 'total_tokens', totalTokens: 500000 });
console.log('levantamiento total_tokens mode avgChars', t.avgCharsPerMessage);

const o = estimateOtbb({ numMessages: 1000, preset: 'correo' });
if (!(o.usdTotal > 0 && o.totalTokens > 0 && o.numBatchesGpt > 0)) {
  throw new Error('estimateOtbb smoke check failed');
}
if (o.batchTagging !== 10 || o.gptOutPerItem !== 45 || o.taxonomyPromptTokens !== 0) {
  throw new Error('modo mensaje no debe cargar la taxonomía de hilos ni cambiar el batch');
}
console.log('otbb usdTotal', o.usdTotal, 'totalTokens', o.totalTokens, 'batches', o.numBatchesGpt);

// Modo hilo: batch de 5, taxonomía en el system prompt y salida por turno.
const oThread = estimateOtbb({ numMessages: 1000, preset: 'correo', analysisMode: 'thread', avgTurnsPerThread: 4 });
if (oThread.batchTagging !== 5 || oThread.numBatchesGpt !== 200) {
  throw new Error('el batch de hilos debe ser de 5 conversaciones');
}
if (oThread.taxonomyPromptTokens <= 0) {
  throw new Error('las bases de flujo y fricciones deben pesar en el prompt de hilos');
}
// Más turnos = más salida: es lo que el modelo viejo no capturaba.
const oThread8 = estimateOtbb({ numMessages: 1000, preset: 'correo', analysisMode: 'thread', avgTurnsPerThread: 8 });
if (!(oThread8.gptOutTok > oThread.gptOutTok && oThread.gptOutTok > o.gptOutTok)) {
  throw new Error('la salida del modo hilo debe crecer con los turnos');
}
console.log('otbb hilo (4 turnos) usdTotal', oThread.usdTotal, 'salida/conversación', oThread.gptOutPerItem, 'tok');
console.log('otbb hilo (8 turnos) usdTotal', oThread8.usdTotal, 'salida/conversación', oThread8.gptOutPerItem, 'tok');

// Los tamaños de catálogo se miden, no se adivinan: las constantes viejas (1600
// tok de catálogo, 800 de maestro activo) subestimaban el coste dominante.
const { masterJson } = getBancaMaster();
const nCodigos = Object.keys(masterJson).length;
if (!(o.claudeCatalogTokens > 10000)) {
  throw new Error(`el catálogo completo (${nCodigos} códigos) debe pesar en la llamada a Claude, no ${o.claudeCatalogTokens} tokens`);
}
if (!(o.gptSysTokens > 3000)) {
  throw new Error(`el maestro activo debe pesar en cada batch de etiquetado, no ${o.gptSysTokens} tokens`);
}
if (oThread.gptSysTokens !== o.gptSysTokens + oThread.taxonomyPromptTokens) {
  throw new Error('el modo hilo debe sumar exactamente las bases de flujo y fricciones al system prompt');
}
// El precio de GPT que se pasa tiene que llegar a las tres fases, no sólo al etiquetado.
const oCaro = estimateOtbb({ numMessages: 1000, preset: 'correo', inputPriceGptPer1m: 20.0, outputPriceGptPer1m: 80.0 });
if (!(oCaro.usdClustering > o.usdClustering * 9)) {
  throw new Error('la fase de clustering ignora los precios de GPT que recibe');
}
console.log('otbb catálogo en Claude', o.claudeCatalogTokens, 'tok | system prompt de etiquetado', o.gptSysTokens, 'tok | taxonomía de hilos', oThread.taxonomyPromptTokens, 'tok');
