export function cellToText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(r => r.text).join('');
    if (value.text != null) return String(value.text);
    if (value.result != null) return String(value.result);
  }
  return String(value);
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : '';
}

function parseDateValue(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial date, days since 1899-12-30.
    return new Date(Math.round((value - 25569) * 86400 * 1000));
  }
  const raw = cellToText(value).trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function isoOrEmpty(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

function normalizeDirection(value) {
  const raw = cellToText(value).trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'true' || raw === '1' || raw === 'si' || raw === 'sí') return 'enviado';
  if (raw === 'false' || raw === '0' || raw === 'no') return 'recibido';
  if (/(recib|entrante|inbound|cliente|incoming|received)/i.test(raw)) return 'recibido';
  if (/(envi|saliente|outbound|ejecutiv|agente|sent|outgoing)/i.test(raw)) return 'enviado';
  return raw;
}

function boolText(value) {
  return value ? 'True' : 'False';
}

function minutesBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return null;
  const diff = b.getTime() - a.getTime();
  return diff >= 0 ? diff / 60000 : null;
}

function hoursBetween(a, b) {
  const minutes = minutesBetween(a, b);
  return minutes == null ? null : minutes / 60;
}

function formatDurationHours(hours) {
  if (!Number.isFinite(hours)) return '';
  const days = Math.floor(hours / 24);
  const rest = round1(hours - days * 24);
  if (days > 0) return `${days}d ${String(rest).replace('.', ',')} hrs`;
  return `${String(round1(hours)).replace('.', ',')} hrs`;
}

function bucketHours(value) {
  if (!Number.isFinite(value)) return 'Sin dato';
  if (value <= 1) return '<=1h';
  if (value <= 4) return '1-4h';
  if (value <= 24) return '4-24h';
  if (value <= 72) return '1-3d';
  return '>3d';
}

function percentile(values, p) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const idx = (nums.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return nums[lo];
  return nums[lo] * (hi - idx) + nums[hi] * (idx - lo);
}

// El orden de `patterns` es orden de PREFERENCIA, no de aparición: se busca el
// primer patrón contra todas las columnas antes de pasar al siguiente. Con la
// búsqueda al revés (recorrer columnas y aceptar cualquier patrón) gana la
// columna que esté más a la izquierda del archivo, no la más específica: en un
// export real con `Id Email` (columna 3, un id de buzón con 5 valores
// distintos en 12.694 filas) y `Message ID` (columna 12, el id real por
// mensaje), el messageIdColumn salía `Id Email` y todo lo que deduplica por
// ahí — incluido el motor de exclusiones — marcaba miles de mensajes legítimos
// como repetidos.
function inferColumn(columns, patterns) {
  for (const pattern of patterns) {
    const match = columns.find(col => String(col || '').toLowerCase().includes(pattern));
    if (match) return match;
  }
  return '';
}

// 'to' es demasiado corto para matchear por substring: 'asunto' lo contiene y
// pisaría subjectColumn. Solo aceptamos 'to'/'para' como nombre exacto de
// columna, más los términos largos que sí son seguros por substring.
function inferToColumn(columns) {
  return columns.find(col => {
    const lower = String(col || '').toLowerCase().trim();
    if (lower === 'to' || lower === 'para') return true;
    return ['destinatario', 'recipient'].some(p => lower.includes(p));
  }) || '';
}

const INTERNAL_COLUMN_EXACT = [
  'is internal',
  'is_internal',
  'isinternal',
  'interno',
  'internal',
  'es_interno',
  'es interno',
  'flag interno',
  'flag_interno',
  'mail interno',
  'mail_interno',
];

/** Columna de metadato que marca si el mensaje es interno (reenvío entre colegas). */
export function inferInternalColumn(columns = []) {
  const exact = columns.find(col => INTERNAL_COLUMN_EXACT.includes(String(col || '').toLowerCase().trim()));
  if (exact) return exact;
  return inferColumn(columns, [
    'is internal',
    'is_internal',
    'isinternal',
    'flag interno',
    'mail interno',
  ]);
}

/** Interpreta el flag de mensaje interno desde distintos formatos de export. */
export function parseInternalFlag(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const raw = cellToText(value).trim().toLowerCase();
  if (!raw) return false;
  if (/^(true|1|si|sí|yes|y|verdadero|interno|internal|interna)$/i.test(raw)) return true;
  if (/^(false|0|no|n|falso|externo|external|externa)$/i.test(raw)) return false;
  const n = Number(raw);
  if (Number.isFinite(n)) return n !== 0;
  return false;
}

function extractDomain(value) {
  const match = cellToText(value).match(/@([A-Za-z0-9._-]+)/);
  return match ? match[1].toLowerCase() : '';
}

// El campo "To" de export de correo suele venir como texto de un objeto/lista
// (p.ej. "[{mail=fulano@banco.cl, name=Fulano}]"), no como email plano.
function extractEmails(value) {
  const text = cellToText(value);
  if (!text) return [];
  const mailMatches = text.match(/mail=([^,}\]]+)/gi);
  if (mailMatches && mailMatches.length) {
    return mailMatches.map(m => m.replace(/^mail=/i, '').trim()).filter(Boolean);
  }
  return (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).filter(Boolean);
}

export function inferThreadColumns(columns = []) {
  return {
    threadColumn: inferColumn(columns, ['thread_id', 'thread id', 'thread', 'hilo', 'conversation_id', 'conversacion', 'conversation']),
    dateColumn: inferColumn(columns, ['fecha', 'date', 'timestamp', 'created', 'creado', 'hora']),
    directionColumn: inferColumn(columns, ['is sent', 'direccion', 'dirección', 'direction', 'sentido', 'tipo', 'origen']),
    subjectColumn: inferColumn(columns, ['subject', 'asunto', 'titulo', 'título']),
    contentColumn: inferColumn(columns, ['combined_msg', 'contenido', 'content', 'body', 'texto', 'mensaje', 'message', 'comentario']),
    messageIdColumn: inferColumn(columns, ['message id', 'message_id', 'id email', 'id_email']),
    fromColumn: inferColumn(columns, ['from', 'remitente', 'sender']),
    toColumn: inferToColumn(columns),
    internalColumn: inferInternalColumn(columns),
  };
}

// Presencia de estos campos en `row` == motor-exclusiones (src/otbb-exclusiones.js)
// ya corrió sobre el archivo crudo, antes de threading.js. Si no corrió (servicio
// apagado, feature deshabilitada), `row.__exclusion_aplicado` no existe y todo acá
// se comporta exactamente igual que antes — el motor es una capa opcional, aditiva.
function exclusionOf(row) {
  if (row.__exclusion_aplicado !== true) return null;
  return {
    excluido: row.__exclusion_excluido === true,
    categoria: row.__exclusion_categoria || '',
    filaEstado: row.__exclusion_fila_estado || '',
    textoParaPrompt: row.__exclusion_texto_para_prompt,
  };
}

const DUPLICADO_PREFIX = 'duplicado';

// Una fila que motor-exclusiones marcó `fila_estado: duplicado_*` es un defecto
// de la ingesta (el archivo trae el mismo correo dos veces), no un turno real de
// la conversación. Ver motor-exclusiones/README.md, "Filas repetidas e
// insistencia no son lo mismo".
function esDuplicadoDeArchivo(row) {
  const exclusion = exclusionOf(row);
  return Boolean(exclusion && exclusion.filaEstado.startsWith(DUPLICADO_PREFIX));
}

/**
 * El texto limpio de UN mensaje: sin banners institucionales, sin el tramo de
 * historial citado que se repite de mensaje en mensaje, y con el asunto
 * fusionado una sola vez por hilo (motor-exclusiones, motor/pipeline.py). Si el
 * motor no corrió, devuelve el crudo — que es lo que se habría mandado igual.
 *
 * Única fuente de verdad de "texto limpio": la usan el transcript del hilo, la
 * columna `clean_text` del detalle y el análisis de sentimiento, para que no
 * puedan divergir entre sí.
 *
 * `marcarExclusion` antepone `[categoría]` a los mensajes que el motor marcó
 * como ruido. Va en TRUE solo para el transcript que lee el LLM, donde saber
 * que un turno fue una respuesta automática cambia la lectura del hilo. En las
 * columnas de texto va en FALSE: la categoría ya viaja en su propia columna
 * (`categoria_exclusion`) y meter la etiqueta dentro del texto ensucia lo que
 * después puntúa el modelo de sentimiento.
 */
export function cleanMessageBody(row, { subjectColumn, contentColumn, marcarExclusion = false } = {}) {
  const exclusion = exclusionOf(row);
  if (exclusion) {
    const limpio = String(exclusion.textoParaPrompt ?? '').trim();
    return marcarExclusion && exclusion.excluido
      ? `[${exclusion.categoria || 'excluido'}] ${limpio}`.trim()
      : limpio;
  }
  const subject = cellToText(row[subjectColumn]).trim();
  const content = cellToText(row[contentColumn]).trim();
  return [subject, content].filter(Boolean).join(': ');
}

export function formatThreadTranscript(messages, config) {
  const {
    directionColumn,
    subjectColumn,
    contentColumn,
  } = config;

  // No se le paga un slot "[n]" del transcript a una fila repetida del archivo.
  const visibles = messages.filter(item => !esDuplicadoDeArchivo(item.row));

  return visibles.map((item, idx) => {
    const direction = normalizeDirection(item.row[directionColumn]) || 'sin_direccion';
    const date = isoOrEmpty(item.date);
    const body = cleanMessageBody(item.row, { subjectColumn, contentColumn, marcarExclusion: true });
    const prefix = [`[${idx + 1}]`, direction, date].filter(Boolean).join(' ');
    return `${prefix} - ${body}`.trim();
  }).join(' || ');
}

/**
 * La conversación limpia del hilo, sin el andamiaje de turno/fecha que necesita
 * el prompt: el mismo contenido que lee el modelo, en un texto legible y
 * reutilizable (sentimiento a nivel de hilo, revisión humana, otros modelos).
 */
export function formatCleanConversation(messages, config) {
  const { subjectColumn, contentColumn } = config;
  return messages
    .filter(item => !esDuplicadoDeArchivo(item.row))
    .map(item => cleanMessageBody(item.row, { subjectColumn, contentColumn }))
    .filter(Boolean)
    .join(' || ');
}

export function computeThreadMetrics(messages, config) {
  const { directionColumn, fromColumn, toColumn, internalColumn = '' } = config;
  const pendingReceived = [];
  const responseHours = [];
  const gapsHours = [];
  let lastDirection = '';
  let previousDirection = '';
  let reaperturas = 0;

  messages.forEach((item, idx) => {
    const direction = normalizeDirection(item.row[directionColumn]);
    if (direction) lastDirection = direction;
    if (direction === 'recibido') {
      if (previousDirection === 'enviado') reaperturas += 1;
      pendingReceived.push(item.date);
    } else if (direction === 'enviado') {
      const receivedDate = pendingReceived.shift();
      const hours = hoursBetween(receivedDate, item.date);
      if (hours != null) responseHours.push(hours);
    }
    if (idx > 0) {
      const gap = hoursBetween(messages[idx - 1].date, item.date);
      if (gap != null) gapsHours.push(gap);
    }
    if (direction) previousDirection = direction;
  });

  const sentCount = messages.filter(item => normalizeDirection(item.row[directionColumn]) === 'enviado').length;
  const receivedCount = messages.filter(item => normalizeDirection(item.row[directionColumn]) === 'recibido').length;
  const internalMessages = messages
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => internalColumn && parseInternalFlag(item.row[internalColumn]));
  const internalCount = internalMessages.length;
  // Turno = posición 1-based del primer mensaje interno, igual numeración que
  // orden_hilo/turnos. Email = destinatario ("To") de ese/esos mensajes.
  const turnoDerivacion = internalCount ? internalMessages[0].idx + 1 : '';
  const emailDerivado = [...new Set(
    internalMessages.flatMap(({ item }) => extractEmails(item.row[toColumn]))
  )].join('; ');
  const firstDirection = normalizeDirection(messages[0]?.row?.[directionColumn]);
  const domains = messages
    .filter(item => normalizeDirection(item.row[directionColumn]) === 'recibido')
    .map(item => extractDomain(item.row[fromColumn]))
    .filter(domain => domain && domain !== 'santander.cl');

  // Composición del hilo, no "tipo de conversación": describe qué lados
  // participaron. 'mixto' es la compuerta de conversación neta del funnel.
  let composicionHilo = 'mixto';
  if (internalCount === messages.length && messages.length > 0) composicionHilo = 'interno';
  else if (receivedCount > 0 && sentCount === 0) composicionHilo = 'inbound';
  else if (sentCount > 0 && receivedCount === 0) composicionHilo = 'outbound';

  // Participación: una sola dimensión, la del flag `Is Internal` — quién estuvo
  // en el hilo, no en qué dirección se escribió.
  //   interno = todos los mensajes son internos (el cliente nunca estuvo)
  //   externo = ningún mensaje es interno (puro cara al cliente)
  //   mixto   = hay de los dos (se derivó o se coordinó internamente)
  //
  // Campo aparte de `composicion_hilo` a propósito: ese mezcla dos dimensiones
  // (el flag interno para 'interno', y la dirección para inbound/outbound/mixto)
  // y además su 'mixto' es la compuerta de conversación neta del funnel
  // (otbb-taxonomia.js, esNetaDeterministica). Redefinirlo movería todas las
  // cifras del embudo. Ojo: el 'mixto' de acá NO es el de allá — este dice
  // "internos + externos", aquel dice "ambas direcciones".
  let participacionHilo = 'externo';
  if (messages.length > 0) {
    if (internalCount === messages.length) participacionHilo = 'interno';
    else if (internalCount > 0) participacionHilo = 'mixto';
  }

  return {
    responseHours,
    tiempo_respuesta_total_horas: round1(responseHours.reduce((a, b) => a + b, 0)),
    tiempo_respuesta_promedio_horas: responseHours.length
      ? round1(responseHours.reduce((a, b) => a + b, 0) / responseHours.length)
      : '',
    tiempo_respuesta_promedio_min: responseHours.length
      ? round1((responseHours.reduce((a, b) => a + b, 0) / responseHours.length) * 60)
      : '',
    n_respuestas_calculadas: responseHours.length,
    silencio_maximo_horas: gapsHours.length ? round1(Math.max(...gapsHours)) : '',
    n_recibidos: receivedCount,
    n_enviados: sentCount,
    iniciado_por: firstDirection === 'enviado' ? 'ejecutivo' : firstDirection === 'recibido' ? 'cliente' : '',
    cerrado_por: lastDirection === 'enviado' ? 'ejecutivo' : lastDirection === 'recibido' ? 'cliente' : '',
    ultimo_mensaje_direccion: lastDirection,
    pendiente: lastDirection === 'recibido' && pendingReceived.length > 0,
    abordado: sentCount > 0,
    derivado: internalCount > 0,
    n_internos: internalCount,
    numDerivados: internalCount,
    turnoDerivacion,
    emailDerivado,
    friccion: '',
    composicion_hilo: composicionHilo,
    participacion_hilo: participacionHilo,
    dominio_cliente: domains[0] || '',
    reaperturas,
  };
}

export function buildThreadRows(rawRows, config) {
  const {
    threadColumn,
    dateColumn,
    directionColumn,
    subjectColumn,
    contentColumn,
    messageIdColumn,
    fromColumn,
    toColumn,
    internalColumn,
  } = config;

  if (!threadColumn || !dateColumn || !contentColumn) {
    throw new Error('Para modo conversación se requieren columnas de thread_id, fecha y contenido.');
  }

  const columns = rawRows.length ? Object.keys(rawRows[0]) : [];
  const resolvedMessageIdColumn = messageIdColumn || inferColumn(columns, ['message id', 'message_id']);
  const resolvedFromColumn = fromColumn || inferColumn(columns, ['from', 'remitente', 'sender']);
  const resolvedToColumn = toColumn || inferToColumn(columns);
  const resolvedInternalColumn = internalColumn || inferInternalColumn(columns);
  const seenMessageIds = new Set();
  const dedupedRows = [];

  rawRows.forEach((row, index) => {
    const messageId = cellToText(row[resolvedMessageIdColumn]).trim();
    if (messageId) {
      if (seenMessageIds.has(messageId)) return;
      seenMessageIds.add(messageId);
    }
    dedupedRows.push({ row, index });
  });

  const groups = new Map();
  dedupedRows.forEach(({ row, index }) => {
    const threadId = cellToText(row[threadColumn]).trim() || `sin_thread_${index + 1}`;
    if (!groups.has(threadId)) groups.set(threadId, []);
    groups.get(threadId).push({
      row,
      index,
      date: parseDateValue(row[dateColumn]),
    });
  });

  const threadRows = [];
  const detailRows = [];

  Array.from(groups.entries()).forEach(([threadId, items], threadIndex) => {
    const sorted = [...items].sort((a, b) => {
      const at = a.date?.getTime?.() ?? Number.POSITIVE_INFINITY;
      const bt = b.date?.getTime?.() ?? Number.POSITIVE_INFINITY;
      return at === bt ? a.index - b.index : at - bt;
    });

    const metrics = computeThreadMetrics(sorted, {
      directionColumn,
      fromColumn: resolvedFromColumn,
      toColumn: resolvedToColumn,
      internalColumn: resolvedInternalColumn,
    });
    const dates = sorted.map(item => item.date).filter(Boolean);
    const start = dates[0];
    const end = dates[dates.length - 1];
    const durationHours = start && end ? hoursBetween(start, end) : null;
    const transcript = formatThreadTranscript(sorted, {
      dateColumn,
      directionColumn,
      subjectColumn,
      contentColumn,
    });
    const cleanConversation = formatCleanConversation(sorted, { subjectColumn, contentColumn });

    let hayExclusion = false;
    let nExcluidosHilo = 0;
    let nDuplicadosArchivoHilo = 0;
    let nInsistenciasHilo = 0;
    const categoriasExclusionHilo = new Set();

    sorted.forEach((item, idx) => {
      const exclusion = exclusionOf(item.row);
      if (exclusion) {
        hayExclusion = true;
        if (exclusion.excluido) {
          nExcluidosHilo += 1;
          if (exclusion.categoria) categoriasExclusionHilo.add(exclusion.categoria);
        }
        if (exclusion.filaEstado.startsWith(DUPLICADO_PREFIX)) nDuplicadosArchivoHilo += 1;
        if (Number(item.row.__exclusion_insistencia_n) > 0) nInsistenciasHilo += 1;
      }

      detailRows.push({
        thread_id: threadId,
        orden_hilo: idx + 1,
        fecha_hilo: isoOrEmpty(item.date),
        direccion_hilo: normalizeDirection(item.row[directionColumn]),
        subject_hilo: cellToText(item.row[subjectColumn]).trim(),
        content_hilo: cellToText(item.row[contentColumn]).trim(),
        // El texto que de verdad se analiza: sin banners, sin el historial ya
        // citado antes en el hilo, y vacío si la fila es un duplicado del
        // archivo. Si el motor no corrió, es el crudo — lo que se habría
        // mandado igual. `content_hilo` se deja intacto al lado, para poder
        // comparar qué se limpió.
        clean_text: esDuplicadoDeArchivo(item.row)
          ? ''
          : cleanMessageBody(item.row, { subjectColumn, contentColumn }),
        message_id_hilo: cellToText(item.row[resolvedMessageIdColumn]).trim(),
        deduplicado_por_message_id: resolvedMessageIdColumn ? 'True' : 'False',
        // Ver motor-exclusiones/README.md "Contrato de salida". Vacío si el
        // motor no corrió sobre este archivo (servicio apagado, feature off).
        excluido_ruido: exclusion ? boolText(exclusion.excluido) : '',
        categoria_exclusion: exclusion ? exclusion.categoria : '',
        regla_id_exclusion: exclusion ? String(item.row.__exclusion_regla_id || '') : '',
        evidencia_exclusion: exclusion ? String(item.row.__exclusion_evidencia || '') : '',
        fila_estado_mensaje: exclusion ? exclusion.filaEstado : '',
        insistencia_n_mensaje: exclusion ? (item.row.__exclusion_insistencia_n ?? '') : '',
        ...item.row,
      });
    });

    threadRows.push({
      thread_id: threadId,
      transcript_hilo: transcript,
      // Mismo contenido que lee el modelo, sin el andamiaje "[n] dirección
      // fecha" del transcript. Es el texto limpio del hilo, reutilizable.
      clean_conversation: cleanConversation,
      n_mensajes_hilo: sorted.length,
      n_interacciones: sorted.length,
      n_recibidos: metrics.n_recibidos,
      n_enviados: metrics.n_enviados,
      fecha_inicio: isoOrEmpty(dates[0]),
      fecha_fin: isoOrEmpty(dates[dates.length - 1]),
      duracion_hilo_horas: round1(durationHours ?? 0),
      duracion_hilo_formateada: formatDurationHours(durationHours ?? 0),
      tiempo_respuesta_total_horas: metrics.tiempo_respuesta_total_horas,
      tiempo_respuesta_promedio_horas: metrics.tiempo_respuesta_promedio_horas,
      tiempo_respuesta_promedio_min: metrics.tiempo_respuesta_promedio_min,
      n_respuestas_calculadas: metrics.n_respuestas_calculadas,
      silencio_maximo_horas: metrics.silencio_maximo_horas,
      iniciado_por: metrics.iniciado_por,
      cerrado_por: metrics.cerrado_por,
      ultimo_mensaje_direccion: metrics.ultimo_mensaje_direccion,
      pendiente_deterministico: boolText(metrics.pendiente),
      composicion_hilo: metrics.composicion_hilo,
      participacion_hilo: metrics.participacion_hilo,
      dominio_cliente: metrics.dominio_cliente,
      reaperturas: metrics.reaperturas,
      pendiente: boolText(metrics.pendiente),
      abordado: boolText(metrics.abordado),
      derivado: boolText(metrics.derivado),
      n_internos: metrics.n_internos,
      DerivacionInterna: boolText(metrics.derivado),
      Num_derivados: metrics.numDerivados,
      Turn_derivados: metrics.turnoDerivacion,
      email_derivado: metrics.emailDerivado,
      friccion: metrics.friccion,
      // Rollup de motor-exclusiones sobre los mensajes de ESTE hilo. Vacíos
      // (no 0) si el motor no corrió: un 0 real dice "corrió y no encontró
      // nada", vacío dice "no se evaluó" — no son lo mismo.
      n_excluidos_hilo: hayExclusion ? nExcluidosHilo : '',
      n_duplicados_archivo_hilo: hayExclusion ? nDuplicadosArchivoHilo : '',
      n_insistencias_hilo: hayExclusion ? nInsistenciasHilo : '',
      categorias_exclusion_hilo: [...categoriasExclusionHilo].join('; '),
      __otbbRowIndex: threadIndex,
    });
  });

  return {
    threadRows,
    detailRows,
    summary: summarizeThreadRows(threadRows, {
      totalRawRows: rawRows.length,
      totalDedupedRows: dedupedRows.length,
      duplicateRows: rawRows.length - dedupedRows.length,
      internalColumn: resolvedInternalColumn,
      internalColumnDetected: Boolean(resolvedInternalColumn),
    }),
  };
}

export function summarizeThreadRows(threadRows = [], base = {}) {
  const totalThreads = threadRows.length;
  const totalInteractions = threadRows.reduce((sum, row) => sum + Number(row.n_interacciones || row.n_mensajes_hilo || 0), 0);
  const durations = threadRows.map(row => Number(row.duracion_hilo_horas)).filter(Number.isFinite);
  const responseAvgs = threadRows
    .map(row => row.tiempo_respuesta_promedio_horas)
    .filter(value => value !== '' && value != null)
    .map(Number)
    .filter(Number.isFinite);
  const responseTotals = threadRows
    .map(row => row.tiempo_respuesta_total_horas)
    .filter((value, idx) => value !== '' && value != null && Number(threadRows[idx].n_respuestas_calculadas || 0) > 0)
    .map(Number)
    .filter(Number.isFinite);
  const bucketCount = (values) => values.reduce((acc, value) => {
    const key = bucketHours(value);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const countBy = (key) => threadRows.reduce((acc, row) => {
    const value = row[key] || 'Sin dato';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});

  return {
    ...base,
    totalThreads,
    totalInteractions,
    multiInteractionThreads: threadRows.filter(row => Number(row.n_interacciones || row.n_mensajes_hilo || 0) > 1).length,
    pendingThreads: threadRows.filter(row => String(row.pendiente_deterministico || row.pendiente).toLowerCase() === 'true').length,
    avgDurationHours: durations.length ? round1(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    avgResponseHours: responseAvgs.length ? round1(responseAvgs.reduce((a, b) => a + b, 0) / responseAvgs.length) : 0,
    avgTotalResponseHours: responseTotals.length ? round1(responseTotals.reduce((a, b) => a + b, 0) / responseTotals.length) : 0,
    p50ResponseHours: round1(percentile(responseAvgs, 0.5)),
    p90ResponseHours: round1(percentile(responseAvgs, 0.9)),
    responseBuckets: bucketCount(responseAvgs),
    durationBuckets: bucketCount(durations),
    composicionHiloDistribution: countBy('composicion_hilo'),
    participacionHiloDistribution: countBy('participacion_hilo'),
    internalMessagesTotal: threadRows.reduce((sum, row) => sum + Number(row.n_internos || 0), 0),
    topDomains: Object.entries(countBy('dominio_cliente'))
      .filter(([domain]) => domain && domain !== 'Sin dato')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
  };
}
