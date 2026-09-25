import assert from 'node:assert/strict';
import {
  createMultitagService,
} from '../multitag-service.js';
import {
  PROD_SAMPLE_MAX,
  selectDeterministicSampleIndices,
} from '../src/etiquetado-sampling.js';
import { Etiquetado } from '../src/etiquetado.js';

function testDeterministicSample() {
  assert.deepEqual(selectDeterministicSampleIndices(10, 4), [0, 3, 6, 9]);
  assert.deepEqual(selectDeterministicSampleIndices(3, 10), [0, 1, 2]);
  assert.deepEqual(selectDeterministicSampleIndices(10, 1), [5]);
  assert.equal(selectDeterministicSampleIndices(1000, 999).length, PROD_SAMPLE_MAX);
}

async function testEndpointSelectionAndOrder() {
  const calls = [];
  const fakeAxios = {
    async post(url, body) {
      calls.push({ url, body });
      if (url.endsWith('/tag_single')) {
        return { data: { categorias: [`WMA00${body.text} - Categoría`], response: 'Sin respuesta' } };
      }
      return { data: { WMA001: body.text === '1' ? 1 : 0, WMA000: body.text === '1' ? 0 : 1 } };
    },
  };
  const service = createMultitagService({
    baseUrl: 'https://multitag.example/',
    axiosClient: fakeAxios,
    concurrency: 2,
  });

  const single = await service.classifySample({
    client: 'test-client',
    taggingMode: 'single',
    items: [{ index: 8, text: '1' }, { index: 2, text: '2' }],
  });
  assert.equal(single.endpoint, '/tag_single');
  assert.deepEqual(single.results.map(result => result.index), [8, 2]);
  assert.ok(calls.every(call => call.url === 'https://multitag.example/tag_single'));

  calls.length = 0;
  const multi = await service.classifySample({
    client: 'test-client',
    taggingMode: 'multi',
    items: [{ index: 0, text: '1' }],
  });
  assert.equal(multi.endpoint, '/tag_only');
  assert.equal(multi.succeeded, 1);
  assert.equal(calls[0].url, 'https://multitag.example/tag_only');
}

async function testFailuresAreExplicitAndNotRetried() {
  let calls = 0;
  const fakeAxios = {
    async post() {
      calls += 1;
      const error = new Error('timeout');
      error.code = 'ECONNABORTED';
      throw error;
    },
  };
  const service = createMultitagService({
    baseUrl: 'https://multitag.example',
    axiosClient: fakeAxios,
  });
  const result = await service.classifySample({
    client: 'test-client',
    taggingMode: 'single',
    items: [{ index: 0, text: 'mensaje' }],
  });

  assert.equal(calls, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /timeout/);
}

async function testSampleLimit() {
  const service = createMultitagService({
    baseUrl: 'https://multitag.example',
    axiosClient: { post: async () => ({ data: {} }) },
    maxSample: 2,
  });
  await assert.rejects(
    service.classifySample({
      client: 'test-client',
      taggingMode: 'multi',
      items: [
        { index: 0, text: 'a' },
        { index: 1, text: 'b' },
        { index: 2, text: 'c' },
      ],
    }),
    /máximo de 2/,
  );
}

async function testProductiveResultAdaptation() {
  const etiquetador = new Etiquetado();
  etiquetador.categorias = {
    WMA001: 'Crédito hipotecario [definición con tildes]',
    WMA000: 'Otros',
  };
  const adapted = etiquetador._buildProdResult(
    { mensaje: 'consulta' },
    4,
    { WMA001: 1, WMA999: 0 },
    'multi',
  );
  assert.equal(adapted.CategoriaAsignada, 'WMA001 - Crédito hipotecario');
  assert.equal(adapted.MuestraIndiceOriginal, 5);
  assert.match(adapted.AdvertenciaMaestro, /WMA999/);
  assert.match(adapted.AdvertenciaMaestro, /WMA000/);

  etiquetador.data = [{ mensaje: '   ' }];
  etiquetador.textColumn = 'mensaje';
  const empty = await etiquetador.runProdSample(() => {}, 'multi', 'test-client', 1);
  assert.equal(empty.meta.estimatedCalls, 0);
  assert.equal(empty.rows[0].CategoriaAsignada, 'WMA000 - Otros');
  assert.equal(empty.rows[0].EstadoEtiquetado, 'empty');
}

testDeterministicSample();
await testEndpointSelectionAndOrder();
await testFailuresAreExplicitAndNotRetried();
await testSampleLimit();
await testProductiveResultAdaptation();

console.log('Etiquetado productivo: tests OK');
