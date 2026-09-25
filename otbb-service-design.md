# Servicio OTBB — agente de análisis de correo comercial → PDF

Diseño técnico para productizar el análisis OTBB (Open The Black Box) como un servicio
FastAPI: recibe un CSV/XLS de correo comercial, usa Claude Sonnet 5 como agente para
redactar el reporte siguiendo la metodología OTBB, y expone el render a PDF como una
herramienta HTTP propia del agente.

---

## 1 · Principios de arquitectura

**El LLM no calcula, redacta.** Nunca se le pasan los hilos completos para que saque
porcentajes — eso es exactamente lo que la metodología (sección 2) pide auditar con
evidencia, no con criterio de un modelo. Un preprocesador determinístico en pandas calcula
el funnel, las auditorías de dirección/categoría y la fricción. Al LLM le llega un JSON
compacto de "abstracciones" ya calculadas + una muestra curada de citas textuales para
redactar. Esto abarata tokens, hace el output reproducible, y evita que el modelo invente
o recalcule mal un número.

**El HTML no lo escribe el LLM de memoria — lo arma sobre un shell fijo.** El
`@font-face`, el logo en base64, las variables de color y la estructura de `<section>`
(sistema de diseño Wird, spec de la sección 7 del prompt de metodología) son siempre los
mismos. El servicio inyecta ese shell; el LLM solo genera el **contenido interno** de cada
sección como fragmento HTML. Esto es la productización directa de lo que la propia
metodología pide en su sección 5 ("los datos van en la lógica... nada de expresiones en
los huecos"), llevado un paso más: ni el CSS del sistema se le pide al LLM.

**El segmento de producto/población lo decide el usuario en el front, no el LLM.** El
archivo puede traer varios productos de naturaleza distinta (ej. 5 productos, de los
cuales el cliente solo quiere analizar 2). Esa selección se resuelve **antes** de llamar
al LLM: se detecta el universo de productos del archivo, el front lo pinta como opciones,
el usuario elige, y esa selección viaja al prompt como un dato ya resuelto — nunca como
una decisión que el modelo deba tomar por su cuenta.

**El render a PDF es un endpoint HTTP propio, no una función interna.** Así el tool del
agente lo invoca como invocaría cualquier otra herramienta (HTTP), y el servicio de render
queda reusable fuera de este pipeline (otros clientes, otros sistemas de diseño) sin
acoplarse a la metodología OTBB ni al parser de Invex/BCH/Coopeuch.

**El navegador que convierte HTML a PDF no vive en el contenedor de la app.** El render
final lo hace un servicio Gotenberg ya desplegado (`https://gotenberg-8-apok.onrender.com`),
no un Chromium/Playwright embebido en `otbb-service`. `POST /render` sigue siendo el
contrato que ve el agente; por dentro, ese endpoint hace un POST multipart al Gotenberg
externo y devuelve el PDF que este responde. Esto saca la dependencia pesada (Chromium)
del contenedor de la API y la deja en un servicio que se puede escalar o reemplazar aparte.

---

## 2 · Flujo end-to-end

```
1. POST /uploads (archivo)
   → parsea el CSV/XLS
   → detecta universo de productos/segmentos (determinístico)
   → responde {upload_id, universo_detectado}

2. Front pinta el universo_detectado como checkboxes/opciones
   → usuario elige subconjunto de productos
   → usuario completa el resto de la sección 6 (enfoque, tasa de conversión, etc.)

3. POST /jobs (upload_id + ReportConfig completo)
   → valida que productos_seleccionados ⊆ universo_detectado
   → dispara process_job en background

4. process_job:
   a) filtra el dataframe a los productos seleccionados
   b) calcula abstracciones (funnel, auditoría, fricción, montos) — pandas, no LLM
   c) arma system prompt = metodología OTBB (fija) + bloque de alcance (dinámico, con
      el universo/selección/exclusión como {dato})
   d) llama a Claude Sonnet 5 con tool_use habilitado (única tool: render_pdf)
   e) Claude redacta las secciones y llama a render_pdf(sections, filename)
   f) el tool hace un POST HTTP a /render (mismo servicio, ruta independiente)
   g) /render envuelve las secciones en el shell fijo y reenvía el HTML + assets
      (fuente, logo) a Gotenberg (https://gotenberg-8-apok.onrender.com) por
      multipart/form-data; escribe el PDF que Gotenberg devuelve en disco

5. GET /jobs/{job_id}/pdf → descarga el PDF final
```

---

## 3 · Estructura del proyecto

```
otbb-service/
├── app/
│   ├── main.py
│   ├── api/
│   │   ├── uploads.py               # POST /uploads
│   │   ├── jobs.py                  # POST /jobs, GET /jobs/{id}, GET /jobs/{id}/pdf
│   │   └── render.py                # POST /render — servicio de render, standalone
│   ├── core/
│   │   ├── config.py
│   │   └── schemas.py               # ReportConfig = sección 6, expuesta al front
│   ├── ingestion/
│   │   ├── parser.py                # valida columnas mínimas (sección 1 del prompt)
│   │   └── aggregator.py            # universo de productos, funnel, auditoría, fricción
│   ├── llm/
│   │   ├── methodology.py           # OTBB_METHODOLOGY_MD — el prompt de metodología, fijo
│   │   ├── prompt_builder.py        # system prompt = metodología + bloque de alcance dinámico
│   │   ├── tools.py                 # JSON schema de render_pdf
│   │   └── agent.py                 # loop de tool_use
│   ├── rendering/
│   │   ├── shell.py                 # HTML fijo: @font-face, logo, tokens, <section> ids
│   │   └── pdf_renderer.py          # httpx: reenvía HTML+assets a Gotenberg externo
│   └── jobs/worker.py               # orquesta parse + agregación + llamada a Claude
├── static/wird/                     # font .ttf + logo .png — se envían como assets a Gotenberg
├── data/
│   ├── uploads/
│   └── outputs/
├── .env                             # GOTENBERG_URL=https://gotenberg-8-apok.onrender.com
└── requirements.txt
```

### Config del endpoint externo

```python
# app/core/config.py
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    gotenberg_url: str = "https://gotenberg-8-apok.onrender.com"
    gotenberg_timeout_s: int = 90   # ver nota de cold start abajo

    class Config:
        env_file = ".env"

settings = Settings()
```

No hay `gotenberg` como servicio en `docker-compose.yml` — no hace falta levantarlo local,
ya está desplegado. Si más adelante se monta una instancia propia (por latencia o por
volumen), solo cambia el valor de `GOTENBERG_URL`; nada del resto del pipeline se toca.

---

## 4 · Config expuesta al front (sección 6 de la metodología → Pydantic)

```python
# app/core/schemas.py
from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum

class Enfoque(str, Enum):
    GESTION = "gestion"           # funnel de servicio/retención
    ORIGINACION = "originacion"   # funnel de venta nueva
    AMBOS = "ambos"                # paralelos, sin comparar cifra a cifra

class TasaConversion(str, Enum):
    OBSERVADA = "observada"        # solo la de esta muestra — nunca inventa un promedio
    ESCENARIOS = "escenarios"      # pesimista/conservador/ideal, declarados como supuesto
    AUTO = "auto"                   # el modelo decide y lo declara explícito

class ReportConfig(BaseModel):
    cliente: str
    periodo_label: str                             # "Junio 2026"
    upload_id: str
    productos_seleccionados: list[str]              # subconjunto elegido en el front
    enfoque: Enfoque
    tasa_conversion: TasaConversion
    escenarios_recuperacion: Optional[dict[str, float]] = None   # {"pesimista":0.05,...}
    poblacion_total_mensual: Optional[int] = None
    n_ejecutivos_o_buzones: Optional[int] = None
    meses_del_corte: int = Field(1, ge=1)
    notas_cliente: Optional[str] = None
```

Campos vacíos (ej. `poblacion_total_mensual=None`) instruyen al prompt a **declarar el
dato como pendiente**, nunca a inventarlo.

---

## 5 · Endpoints

### `POST /uploads` — detecta el universo antes de pedir la config

```python
# app/api/uploads.py
@router.post("/uploads")
async def upload_file(file: UploadFile):
    upload_id = str(uuid4())
    path = f"/data/uploads/{upload_id}_{file.filename}"
    with open(path, "wb") as f:
        f.write(await file.read())

    df = parse_input(path)
    universo = detect_universo_productos(df)   # determinístico, no LLM
    return {"upload_id": upload_id, "universo_detectado": universo}
```

```python
# app/ingestion/aggregator.py
def detect_universo_productos(df: pd.DataFrame) -> list[dict]:
    col = pick_product_column(df)   # ProductoNegocio / Macro Producto / Producto — el que exista
    counts = df[col].value_counts(dropna=False)
    return [{"producto": str(p), "n_hilos": int(n)} for p, n in counts.items()]
```

Respuesta ejemplo, lo que el front pinta como checkboxes:

```json
{
  "upload_id": "a1b2c3",
  "universo_detectado": [
    {"producto": "Crédito Consumo", "n_hilos": 35},
    {"producto": "Tarjeta Débito", "n_hilos": 20},
    {"producto": "Hipotecario", "n_hilos": 18},
    {"producto": "Seguros", "n_hilos": 15},
    {"producto": "Cuenta Corriente", "n_hilos": 12}
  ]
}
```

### `POST /jobs` — valida selección contra el universo y dispara el pipeline

```python
# app/api/jobs.py
@router.post("/jobs")
async def create_job(config: ReportConfig, bg: BackgroundTasks):
    df = load_upload(config.upload_id)
    universo = detect_universo_productos(df)
    validos = {u["producto"] for u in universo}
    if not set(config.productos_seleccionados).issubset(validos):
        raise HTTPException(422, "productos_seleccionados no coincide con el universo detectado")

    job_id = str(uuid4())
    bg.add_task(process_job, job_id, df, config, universo)
    return {"job_id": job_id, "status": "processing"}

@router.get("/jobs/{job_id}/pdf")
async def get_pdf(job_id: str):
    return FileResponse(f"/data/outputs/{job_id}.pdf", media_type="application/pdf")
```

### `POST /render` — servicio de render, standalone, consume Gotenberg externo

```python
# app/rendering/shell.py
# El shell ya NO embebe base64 — referencia los assets por nombre plano, tal como
# Gotenberg espera (todos los archivos de una misma request quedan en un directorio
# temporal compartido, sin subcarpetas ni rutas absolutas).
FONT_CSS = '''
@font-face{
  font-family:"Mona Sans";
  src:url("MonaSans-VariableFont_wdth_wght.ttf") format("truetype-variations");
  font-weight:200 900; font-stretch:75% 125%; font-display:swap;
}
'''
LOGO_TAG = '<img src="wird-logo-white.png" style="height:22px" />'
```

```python
# app/rendering/pdf_renderer.py
import httpx
from pathlib import Path
from app.core.config import settings

ASSETS_DIR = Path("static/wird")
GOTENBERG_HTML_ROUTE = f"{settings.gotenberg_url}/forms/chromium/convert/html"

def render_pdf(sections: dict[str, str], filename: str) -> bytes:
    html = wrap_in_shell(sections)   # shell fijo, assets referenciados por nombre plano

    files = [
        ("files", ("index.html", html, "text/html")),
        ("files", ("MonaSans-VariableFont_wdth_wght.ttf",
                    (ASSETS_DIR / "MonaSans-VariableFont_wdth_wght.ttf").read_bytes(),
                    "font/ttf")),
        ("files", ("wird-logo-white.png",
                    (ASSETS_DIR / "wird-logo-white.png").read_bytes(),
                    "image/png")),
    ]
    data = {
        "singlePage": "true",       # Gotenberg calcula el alto real del contenido
        "printBackground": "true",  # conserva la portada navy y los tiles oscuros
        "paperWidth": "15",         # 1440px de diseño / 96dpi
        "marginTop": "0", "marginBottom": "0",
        "marginLeft": "0", "marginRight": "0",
    }
    headers = {"Gotenberg-Output-Filename": filename}

    resp = httpx.post(
        GOTENBERG_HTML_ROUTE, files=files, data=data, headers=headers,
        timeout=settings.gotenberg_timeout_s,
    )
    resp.raise_for_status()
    return resp.content   # bytes del PDF
```

```python
# app/api/render.py
@router.post("/render")
async def render_pdf_endpoint(payload: RenderRequest):
    """
    payload = { "sections": {"portada": "<div>...", ...}, "filename": "invex_junio2026" }
    """
    pdf_bytes = render_pdf(payload.sections, payload.filename)
    out_path = f"/data/outputs/{payload.filename}.pdf"
    Path(out_path).write_bytes(pdf_bytes)
    return {"pdf_path": out_path, "download_url": f"/files/{payload.filename}.pdf"}
```

**Nota sobre el timeout:** si `gotenberg-8-apok.onrender.com` corre en un plan de Render
con auto-sleep, la primera request tras inactividad puede tardar bastante más (cold start)
que las siguientes. Por eso `gotenberg_timeout_s` es configurable y no un valor fijo corto
en el cliente httpx — vale la pena confirmar el plan real del servicio antes de fijar este
número en producción, y considerar un reintento simple si la primera llamada da timeout.

Si mañana se quiere reusar este endpoint para otro cliente con otro sistema de diseño, es
la misma ruta con otro `wrap_in_shell` — no está acoplado a Invex, a la metodología OTBB,
ni a que el render sea Gotenberg (bastaría con cambiar `pdf_renderer.py` si se migra a
otro motor).

---

## 6 · Preprocesador — abstracciones determinísticas, filtradas por selección

```python
# app/ingestion/aggregator.py
def build_abstractions(df: pd.DataFrame, config: ReportConfig, universo_detectado: list[dict]) -> dict:
    col = pick_product_column(df)
    incluidos = df[df[col].isin(config.productos_seleccionados)]
    excluidos = [u for u in universo_detectado if u["producto"] not in config.productos_seleccionados]

    audit = audit_direction_field(incluidos)          # detecta inversión From/To (ver hallazgo Invex)
    audit_categoria = audit_catchall_category(incluidos)  # reclasifica "Otros" por contenido
    funnel = compute_funnel_gates(incluidos)
    friccion = compute_friction_by_stage(incluidos)
    montos = extract_amounts(incluidos)               # regex, reporta cobertura real
    citas = sample_verbatim_quotes(incluidos, n=6)

    return {
        "universo": {
            "n_muestreado_total": len(df),
            "n_analizable_seleccionado": int(incluidos['contenido_evaluable'].sum()),
            "productos_incluidos": config.productos_seleccionados,
            "productos_excluidos": excluidos,   # nunca se descarta en silencio
        },
        "auditoria": {"direccion_invertida": audit, "categoria_contaminada": audit_categoria},
        "funnel": funnel,
        "friccion": friccion,
        "montos": montos,
        "citas_citables": citas,
    }
```

---

## 7 · Prompt builder — la metodología es fija, el alcance es dinámico

`OTBB_METHODOLOGY_MD` (metodología completa, secciones 0–7, ver anexo) se mantiene
genérica y reutilizable entre clientes (Invex, BCH, Coopeuch) sin editarla. Lo único que
cambia por corrida es el bloque de alcance, armado con el dato real que llegó del front —
nunca una decisión que el modelo tome por su cuenta.

```python
# app/llm/prompt_builder.py

SEGMENT_SCOPE_BLOCK = """
ALCANCE DE PRODUCTOS PARA ESTA CORRIDA — fijado desde el front, no es una decisión tuya:

Universo detectado en la base subida: {universo_detectado}
Productos incluidos en este análisis: {productos_seleccionados}
Productos excluidos explícitamente por el usuario: {productos_excluidos}

Reglas:
- Analiza únicamente los hilos cuyo producto está en la lista de incluidos. No calcules
  ni menciones cifras de los productos excluidos salvo para la nota de método de abajo.
- Si la lista de incluidos tiene más de un producto de naturaleza distinta (ticket o ciclo
  distintos entre sí), trátalos como análisis paralelos según la sección 2.2 de la
  metodología: no compares cifra a cifra entre ellos, compara patrones (tasas, concentración
  de causa).
- Si el volumen excluido supera el 15% de la base total muestreada, decláralo en una nota
  de método (sección "cierre"): cuántos hilos quedaron fuera y de qué producto, sin analizarlos.
"""

def build_system_prompt(config: ReportConfig, universo_detectado: list[dict]) -> str:
    excluidos = [u for u in universo_detectado if u["producto"] not in config.productos_seleccionados]
    scope = SEGMENT_SCOPE_BLOCK.format(
        universo_detectado=json.dumps(universo_detectado, ensure_ascii=False),
        productos_seleccionados=json.dumps(config.productos_seleccionados, ensure_ascii=False),
        productos_excluidos=json.dumps(excluidos, ensure_ascii=False),
    )
    return OTBB_METHODOLOGY_MD + "\n\n" + scope + "\n\n" + OUTPUT_RULES_BLOCK

OUTPUT_RULES_BLOCK = """
REGLAS DE OUTPUT:
- No calcules ni re-derives porcentajes: usa únicamente los números en "abstracciones".
- Si un campo de "abstracciones" es null (ej. poblacion_total_mensual), decláralo
  explícitamente como pendiente — no lo estimes.
- Genera SOLO el contenido interno de cada <section> (ver contrato de secciones abajo),
  nunca el <head>, @font-face, ni el <img> del logo — eso lo inyecta el servicio.
- Al terminar todas las secciones, llama a la herramienta render_pdf exactamente una vez.

CONTRATO DE SECCIONES (ids fijos que el shell ya espera):
portada, hallazgos, auditoria, funnel, donde_se_apaga, friccion, alcance, mapeo, cierre
"""

def build_user_message(config: ReportConfig, abstractions: dict) -> str:
    return json.dumps({"config": config.model_dump(), "abstracciones": abstractions},
                       ensure_ascii=False, indent=2)
```

---

## 8 · Tool schema + loop del agente

```python
# app/llm/tools.py — lo único que Claude puede invocar
RENDER_PDF_TOOL = {
    "name": "render_pdf",
    "description": "Envía las secciones HTML del reporte al servicio de render y obtiene el PDF final.",
    "input_schema": {
        "type": "object",
        "properties": {
            "sections": {"type": "object", "additionalProperties": {"type": "string"}},
            "filename": {"type": "string"}
        },
        "required": ["sections", "filename"]
    }
}
```

```python
# app/llm/agent.py
import anthropic, httpx

client = anthropic.Anthropic()
RENDER_URL = "http://localhost:8000/render"

def execute_tool(call):
    if call.name == "render_pdf":
        resp = httpx.post(RENDER_URL, json=call.input, timeout=60)
        resp.raise_for_status()
        return resp.json()   # {"pdf_path": ..., "download_url": ...}

def run_agent(config: ReportConfig, abstractions: dict, universo_detectado: list[dict]) -> dict:
    system = build_system_prompt(config, universo_detectado)
    messages = [{"role": "user", "content": build_user_message(config, abstractions)}]

    while True:
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=8000,
            system=system,
            tools=[RENDER_PDF_TOOL],
            messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})

        tool_calls = [b for b in resp.content if b.type == "tool_use"]
        if not tool_calls:
            return {"status": "sin_tool_call", "raw": resp}  # revisar prompt — no debería pasar

        results = []
        final_result = None
        for call in tool_calls:
            result = execute_tool(call)
            final_result = result
            results.append({"type": "tool_result", "tool_use_id": call.id, "content": json.dumps(result)})
        messages.append({"role": "user", "content": results})

        if resp.stop_reason != "tool_use":
            return final_result
```

---

## 9 · Almacenamiento

Disco local del servicio, sin capa de bucket todavía:

```
/data/uploads/{upload_id}_{filename}     # archivo original subido
/data/outputs/{job_id}.pdf               # PDF final, servido por GET /jobs/{id}/pdf
```

`process_job` corre en `BackgroundTasks` de FastAPI (parseo + agregación + llamada a
Claude); el render vive detrás de su propio endpoint y no bloquea el proceso principal
más de lo necesario para el POST HTTP interno.

---

## 10 · Piezas pendientes de escribir (son código directo, no diseño nuevo)

- `shell.py` — el HTML fijo con el sistema de diseño Wird (fuente, logo, tokens, CSS),
  ahora referenciando assets por nombre plano en vez de base64. Es, literalmente, el
  shell que ya se validó generando el reporte de Invex, solo con esa referencia cambiada.
- `aggregator.py` completo — `audit_direction_field`, `audit_catchall_category`,
  `compute_funnel_gates`, `compute_friction_by_stage`, `extract_amounts` son la
  productización directa del análisis manual ya corrido sobre el Excel de Invex.
- `OTBB_METHODOLOGY_MD` — el prompt de metodología completo (secciones 0–7), como
  constante de texto en `app/llm/methodology.py`.
- Confirmar el plan/tier de `gotenberg-8-apok.onrender.com` (auto-sleep o siempre activo)
  antes de fijar `gotenberg_timeout_s` en producción, y decidir si vale la pena un
  reintento automático en `pdf_renderer.py` para el caso de cold start.

---

## 11 · Dependencias del proyecto

```
fastapi
uvicorn
pandas
openpyxl
pydantic
pydantic-settings
anthropic
httpx
```

Ya no se incluye `playwright` — el render lo resuelve el Gotenberg externo, así que el
contenedor de `otbb-service` no necesita Chromium instalado.
