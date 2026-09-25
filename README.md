# Invento App
Aplicación web para el análisis y categorización automática de comunicaciones de clientes utilizando modelos de lenguaje (LLMs).

## Módulos

### Levantamiento
Descubre automáticamente temas y categorías a partir de datos de comunicación con clientes (emails, redes sociales, encuestas, resúmenes de llamadas). Usa clustering con IA para agrupar temas similares y generar un modelo de categorías en formato JSON.

Opcionalmente, al seleccionar una **vertical experta** (Banca, Retail, Seguros o Telefonía) el módulo también genera una **agrupación por dominio experto**: mapea cada código `WMAnnn` a una Categoría Principal del catálogo experto (Oportunidad Comercial, Solicitud/Consulta, Reclamo, etc.) con su definición. La UI ofrece dos descargas independientes:

1. `categorias-especificas-YYYY-MM-DD.json` — `{WMAnnn: "descripción", ...}`.
2. `categorias-generales-YYYY-MM-DD.json` — `{vertical, categorias_generales, mapa_codigo_general, categorias_especificas}` para auditar e iterar.

### Etiquetado
Clasifica textos en categorías predefinidas (generadas por Levantamiento o cargadas manualmente). Soporta etiqueta única (SingleTag) y múltiple (MultiTag), con dos modos de ejecución:

- **Prod:** ejecuta una muestra determinística y configurable contra `multitag-api`. SingleTag usa `/tag_single`; MultiTag usa `/tag_only` para evitar la segunda llamada de merge de templates. Los textos vacíos se asignan localmente a `WMA000` sin consumir llamadas.
- **Testing:** procesa el dataset con el pipeline local y GPT-5.2, usando batches de mensajes.

El modo Prod tiene un máximo configurable de muestra (200 por defecto), limita la concurrencia y no reintenta automáticamente para evitar duplicar gasto. Los errores técnicos se conservan como `ERROR`; no se mezclan con `WMA000`. En MultiTag se requiere el maestro JSON local para traducir códigos y se advierten diferencias respecto de los códigos devueltos por producción.

En Testing, la respuesta incluye `evidence` (fragmentos literales), `justification` y `confidence` (0-1). Para mensajes `WMA000` pueden solicitarse **sugerencias expertas** por RAG contra `data/catalogo_categorias.json`. La vista de resultados y el Excel identifican fuente, estado operativo, índice original de la muestra y posibles desajustes del maestro.

### AutoQA
Gestión de modelos de clasificación almacenados en Azure File Share. Permite subir, descargar y eliminar modelos JSON.

### Calculadora
Estima tokens y coste en USD para **Etiquetado** (alineado al estimador `estimate_use_case_cost.py` con prompts de esta app), **Levantamiento** (aproximación por lotes GPT + Claude + formateo JSON) y **AutoQA** (tamaño del JSON; sin LLM en el módulo). Requiere el backend en marcha: las rutas van bajo `/api/calculator/*`.

## Tech Stack
- **Frontend:** React 18, Vite, Tailwind CSS
- **Backend:** Express.js (Node.js)
- **APIs de IA:** Anthropic (Claude Sonnet 5), OpenAI (GPT-4.1), Google Gemini 2.0 Flash
- **Almacenamiento:** Azure Storage File Share
- **Monitoreo:** Datadog APM

## Variables de Entorno
Crear un archivo `.env` en la raíz del proyecto:

```env
ANTHROPIC_API_KEY=tu_api_key_anthropic
OPENAI_KEY=tu_api_key_openai
GEMINI_API_KEY=tu_api_key_gemini
# Servicio productivo de etiquetado
MULTITAG_API_URL=https://host-de-multitag-api
# Opcional si multitag-api utiliza Bearer token
MULTITAG_API_TOKEN=
MULTITAG_MAX_SAMPLE=200
MULTITAG_CONCURRENCY=5
MULTITAG_TIMEOUT_MS=120000
AZURE_STORAGE_CONNECTION_STRING=tu_connection_string_azure
AZURE_SHARE_NAME=nombre_del_file_share
LOGIN_USER=usuario
LOGIN_PASSWORD=contraseña
PORT=3001
VITE_PROXY_PORT=3001
ALLOWED_ORIGINS=https://tu-dominio.com
BODY_LIMIT=50mb
# Modelo de embeddings para el catálogo experto (RAG). Requiere OPENAI_KEY.
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

(Sin `LOGIN_USER` / `LOGIN_PASSWORD`, el endpoint `/login` falla. En local puedes usar los valores de `.env.example`.)

## Instalación

```bash
npm install
```

## Ejecución

### Desarrollo
```bash
# Terminal 1: Frontend (Vite dev server)
npm run dev

# Terminal 2: Backend (Express proxy server)
npm run proxy
```

Vite reenvía `/api` y el resto de rutas del backend al puerto definido en `.env` (`PORT` y `VITE_PROXY_PORT`, por defecto `3001`). Deben coincidir.

Para usar Etiquetado en modo Prod, el backend debe tener `MULTITAG_API_URL`. Esta URL y su token nunca se exponen al navegador.

### Pruebas y verificación
```bash
npm test
npm run lint
npm run build
```

Las pruebas de etiquetado productivo usan respuestas simuladas y no consumen tokens ni realizan llamadas reales a `multitag-api`.

#### No arranca el backend (`EADDRINUSE` / puerto en uso)
Otro proceso está usando el puerto (suele ser una instancia anterior de `npm run proxy`). Opciones:

1. **Cerrar el proceso en Windows (PowerShell como administrador si hace falta):**
   ```powershell
   netstat -ano | findstr :3001
   taskkill /PID <número_PID> /F
   ```
2. **Usar otro puerto:** copia `.env.example` a `.env` y pon, por ejemplo, `PORT=3002` y `VITE_PROXY_PORT=3002` (mismo valor en ambas). Reinicia `npm run dev` y `npm run proxy`.

### Endpoints del catálogo experto
El backend expone tres rutas que alimentan los módulos nuevos de QA y agrupación general:

- `GET /api/catalog/verticals` — devuelve el árbol `{vertical: {categoríaPrincipal: {subs, examples}}}`. Usado por la UI para poblar los selectores de vertical.
- `POST /api/catalog/suggestions` — body `{ text, vertical?, topK? }`. Ejecuta RAG (embeddings + similaridad coseno) sobre `data/catalogo_categorias.json` y GPT-4.1 rankea hasta 3 sugerencias con `rationale` y `match_strength`. Se llama automáticamente desde Etiquetado al detectar `WMA000`.
- `POST /api/catalog/general-grouping` — body `{ vertical, flat }`. Mapea cada código `WMAnnn` a una de las Categorías Principales de la vertical (enum restringido + `Otros`) con su definición. Se consume en Levantamiento cuando se elige una vertical experta.

El índice de embeddings se cachea en `.cache/catalog_embeddings.json`. El archivo se invalida automáticamente si cambia `data/catalogo_categorias.json` (por mtime) o el modelo `OPENAI_EMBEDDING_MODEL`. En el arranque del servidor se calienta en background.

### Endpoint de etiquetado productivo
- `POST /api/etiquetado/prod-sample` — proxy interno hacia `multitag-api`. Recibe `{ client, taggingMode, items: [{ index, text }] }`, aplica el máximo y la concurrencia configurados, y devuelve resultados independientes por fila.

El endpoint rechaza muestras sobre el límite, valida el cliente y el contrato de respuesta, y cancela las llamadas pendientes si el navegador aborta el proceso. No implementa reintentos automáticos.

### Producción
El proyecto incluye Dockerfiles para frontend y backend:

- `dockerfile.frontend` — Construye y sirve el frontend en el puerto 4173
- `dockerfile.backend` — Ejecuta el servidor Express en el puerto 3001

## Estructura del Proyecto

```
├── src/
│   ├── App.jsx           # Componente principal con navegación por tabs
│   ├── Calculadora.jsx   # UI de estimación de costes
│   ├── invento.js        # Lógica de Levantamiento (clustering y categorización)
│   ├── etiquetado.js     # Etiquetado local y adaptación de resultados productivos
│   ├── etiquetado-sampling.js # Selección reproducible y límites de muestra
│   ├── EtiquetadoResultsView.jsx # Resultados, QA y exportación
│   ├── AutoQA.jsx        # UI de gestión de modelos
│   ├── Login.jsx         # Autenticación
│   ├── prompts.json      # Prompts de IA para clustering
│   └── utils.js          # Utilidades (control de concurrencia)
├── calculator-service.js # Lógica de estimación (tokens/USD); usado por server.js
├── catalog-service.js    # Carga, embed, cache y búsqueda del catálogo experto (RAG)
├── multitag-service.js   # Cliente server-side de multitag-api
├── scripts/
│   └── test-etiquetado-prod.mjs # Pruebas sin consumo de tokens
├── data/
│   └── catalogo_categorias.json   # Taxonomía experta (Banca/Retail/Seguros/Telefonía)
├── .cache/
│   └── catalog_embeddings.json    # Cache de embeddings (generado en runtime)
├── server.js             # Backend Express, proxies y endpoint de muestra productiva
├── package.json
├── vite.config.js
├── dockerfile.frontend
├── dockerfile.backend
└── bitbucket-pipelines.yml
```