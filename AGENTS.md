# Instrucciones para agentes

Proyecto: compras-publicas-cl, un lakehouse medallion en GCP con Mercado Público y Banco Central (repo de portafolio).
Stack fijo (R-01 de spec/SPEC.md): GCP en us-central1 (GCS, BigQuery, Dataform, Cloud Run Jobs y functions, Scheduler,
Workflows, Secret Manager, Artifact Registry, Pub/Sub solo para el presupuesto, Monitoring, IAM, policy tags); Terraform ≥ 1.7
con el proveedor `google`; Python 3.12 con uv; Node.js ≥ 22 para Dataform y las guardas; GitHub Actions. Sin Composer.
Protocolo: Cierre por Riesgo (PCR, sdd-base), variante "desarrollador único": `PLAN` vive como sección de `spec/SPEC.md`.

## Lectura obligatoria al iniciar (en este orden)
1. spec/LOG.md — última entrada: "Próxima acción autorizada"
2. spec/TASKS.json — tareas `in_progress`, `blocked` y la primera `ready`
3. spec/SPEC.md — Objetivo, Alcance, Plan y requisitos citados por la tarea
4. Decisiones: en autopilot, solo las que te nombra el prompt (DEC-036); en sesión,
   `node scripts/adr.mjs select --task T-NN --files` (las citadas por la tarea, los ADR vigentes más recientes y los de
   los módulos que toca). Los ADR están en `spec/adr/`; las reversibles, en spec/DECISIONS.md
5. git log -n 20

No cargues la spec completa si la tarea no la cita. Nunca reconstruyas estado desde el chat.

## Estructura
- `infra/` — Terraform: `bootstrap/` (estado, WIF, presupuesto; lo aplica el usuario), `main/` y `modules/`
- `ingest/` — paquete Python `compras_ingest` (Mercado Público, Banco Central, mindicador → GCS → BigQuery raw) y su `Dockerfile`
- `finops/killswitch/` — función que desvincula el billing al llegar al tope (DEC-003)
- `dataform/` — silver, gold, cuarentena y assertions (`definitions/`, `includes/reglas.js`)
- `orchestration/` — el Workflow diario (DEC-002)
- `benchmarks/` — benchmark antes y después (DEC-007)
- `scripts/setup.sh` (la única con red), `scripts/acceptance.sh`, `scripts/ci/` (check:repo, check:descriptions,
  check:readme), `scripts/it/` (verificaciones de integración contra GCP: solo con aprobación del usuario)
- `.github/workflows/` — CI (plan en el PR) y despliegue (apply en `main`)
- `spec/contracts/` — contratos de la API (fuente única)
- `scripts/` — guardas del protocolo (`check-spec.mjs`, `autopilot.sh`, `lib/`) y sus pruebas (`scripts/test/`)
- `tests/acceptance/` — **protegida**: solo la editan tareas `"kind": "spec"` y, con el test-author activo (DEC-006 de
  sdd-base), el test-author en `tests/acceptance/<ID>*` de cada tarea; su diff lo aprueba el usuario (o el revisor, si
  es aditivo y el proyecto lo activó; DEC-004 de sdd-base)
- `research/` — informes del investigador (DEC-005 de sdd-base): los escribe solo el investigador que lanza el
  orquestador; no los edites

## Comandos
- Preparar entorno: `scripts/setup.sh` (mise local en `.tools/`, sin sudo; es el único paso con red). Todo comando de
  herramientas va con `scripts/env.sh <comando>`: no uses terraform, node, uv ni python globales
- Pruebas: `npm test` | Aceptación: `scripts/acceptance.sh <archivo>` | Lint/tipos: `npm run lint`
- Desplegar: merge a `main` (GitHub Actions aplica `infra/main`); `infra/bootstrap` lo aplica el usuario a mano (solo el usuario; ver Autoridad)
- Validar protocolo: `npm run check:spec` (también lo corre el hook `commit-msg` de `.githooks/`)
- Cobertura desde aceptación: `npm run check:coverage` (DEC-011 de sdd-base; con `spec/COVERAGE.json`): toda línea de
  código la ejecuta una prueba de `tests/acceptance/` que cita un REQ; lo no alcanzado se borra o se escala como
  requisito faltante, nunca se excluye
- Pruebas del protocolo: `npm run test:sdd`
- Orquestador (autopilot): `scripts/autopilot.sh [--dry-run]` (nunca `accepted`; push solo si el
  proyecto lo configura con `AUTOPILOT_PUSH_REMOTE` (DEC-004 de sdd-base): lo hace el orquestador tras cada veredicto
  `approved`, sin `--force`, y nunca sobre una rama que despliega a producción; el agente nunca hace push; despliegue
  solo si el proyecto configura `AUTOPILOT_DEMO_DEPLOY_CMD` (DEC-004): lo hace el orquestador en una cuenta demo cuya
  identidad comprueba contra `AUTOPILOT_DEMO_ACCOUNTS`, y relanza la tarea; el agente nunca despliega; configuración en
  `scripts/autopilot.config.sh`; progreso en `.autopilot/<corrida>/live.log`; tareas `"kind": "tooling"` usan `Req: N/A`;
  aviso ntfy al detenerse si `NTFY_TOPIC` está en `~/.config/autopilot/autopilot.config.sh`, fuera de git)
  En autopilot la tarea que necesita desplegar lo declara en su resultado con `"deploy": {"what", "then"}` (qué
  desplegar y qué correr después; T-39 de sdd-base): queda `in_progress`, el orquestador escribe la línea
  «Pendiente deploy» en LOG.md y sigue con la siguiente. Con el despliegue demo
  configurado, el orquestador despliega y te relanza con el resultado en el prompt: sigue la tarea con ese resultado.
  Una tarea `"kind": "spec"` que escribe `tests/acceptance/` queda `in_progress` hasta que se apruebe su diff. Con
  `AUTOPILOT_ACCEPTANCE_REVIEW=additive` (DEC-004), si el diff solo agrega archivos o líneas, lo revisa el revisor
  independiente (cada prueba nueva = un ejemplo de un REQ citado; ninguna trivial ni con skip/only); si lo aprueba, el
  orquestador lo anota en `acceptance_review` de la tarea y te relanza: sigue la tarea como si el usuario lo hubiera
  aprobado. Borrar o cambiar una prueba existente sigue necesitando al usuario.
  Con `AUTOPILOT_TEST_AUTHOR=on` (DEC-006), antes de implementar una tarea con REQ el orquestador lanza un test-author
  que escribe `tests/acceptance/<ID>*` solo desde SPEC.md y `spec/contracts/`, comprueba que fallan (rojo) y espera su
  aprobación. Como implementador puedes leer esas pruebas y debes hacerlas pasar, pero nunca editas, renombras ni borras
  nada en `tests/acceptance/`: si tus commits lo tocan, la corrida se detiene. Si crees que una prueba está mal, no la
  cambies: pide el bloqueo con `blocked_by` igual al REQ que codifica y `"test_dispute": {"file", "reason"}` en tu
  resultado; decide el orquestador (investigador o usuario). Tu resultado solo se cierra si las pruebas pasan.
  Con `AUTOPILOT_PLAN_GATE=on` (DEC-010), antes de implementar una tarea un planificador escribe `plans/<ID>.md` y un
  crítico con contexto limpio lo aprueba; como implementador recibes la ruta del plan aprobado: síguelo y no edites
  `plans/`. Si resulta equivocado, no improvises otro enfoque: pide el bloqueo con `blocked_by` igual al REQ o la DEC
  que falla y explica por qué en `notes`.
  El `verify` de cada tarea es un comando local que imprime conteos de pruebas (sin red ni costo); lo que necesita
  la nube o el claude real va en `verify_integration` y solo corre con aprobación del usuario (DEC-019 de sdd-base).
  Tu evidencia no la escribes tú (DEC-014 de sdd-base): al terminar, un hook Stop corre el `verify` de la tarea con
  `scripts/record_evidence.py`; si falla, no puedes cerrar y recibes la ruta del log. El orquestador vuelve a correrlo y
  escribe `evidence` y el estado. No edites `spec/TASKS.json` ni `artifacts/` (la guarda de acceso lo niega).
  Tampoco escribes resultados de pruebas en LOG.md (T-35 de sdd-base): ni una línea «Verificado» ni conteos. El
  orquestador agrega esa línea desde la evidencia; en sesión interactiva se copia de
  `node scripts/lib/autopilot-tasks.mjs verified-line T-NN`.
  Con `spec/COVERAGE.json` (DEC-011), el orquestador no cierra tu resultado si una línea que agregaste o
  cambiaste no la ejecuta ninguna prueba de `tests/acceptance/` que cite un REQ: no escribas código que ningún REQ pide.
  Si una línea es necesaria y ningún REQ la cubre, no agregues pruebas ni requisitos: pide el bloqueo con
  `"missing_requirement": {"lines", "reason"}`; el orquestador lo escala como requisito faltante. `lines` es
  `<ruta>:<línea>[-<línea>]` (separadas por comas) de archivos que existen en tus `touches`, y una prueba disputada tiene
  que existir y ser de la tarea: el orquestador lo comprueba (T-40 de sdd-base).
  Con `AUTOPILOT_RESEARCH=web|deep` (DEC-005), si una tarea falla dos veces seguidas el orquestador lanza un
  investigador (solo lectura, con acceso web y topes de tiempo y costo) que deja `research/<ID>.md`; con su informe
  reintenta una vez o escala la tarea al usuario (`blocked` con una `Q-NN` nueva). Si te relanza con una nota de
  investigación, lee ese informe antes de empezar: es un consejo, no una autoridad (mandan este archivo, `touches` y
  los REQ/DEC). Nunca lances al investigador ni escribas en `research/`.
  En autopilot cada rol (implementador, revisor, investigador) corre en una sesión nueva y efímera, con el agente que el
  proyecto eligió (DEC-008 de sdd-base): recibes solo el prompt del orquestador y lo que el protocolo manda leer. No
  leas `.autopilot/` (los registros de la corrida y de los otros agentes) ni los datos de sesiones de tu agente: si lo
  haces, la corrida se detiene.

## En autopilot: un solo escritor de `spec/`
Si `AUTOPILOT_RESULT` está definido, la sesión la lanzó el orquestador y esto reemplaza las reglas de abajo que piden
editar `spec/`:
- No edites nada de `spec/` (ni TASKS.json ni LOG.md) y no toques rutas fuera de `touches` de la tarea: si un commit
  lo hace, la tarea falla sin aplicar nada.
- Haz commit solo del código (con sus trailers) y deja el resultado como un objeto JSON en el archivo
  `$AUTOPILOT_RESULT`. No lleva `status` ni `evidence` (DEC-014): el orquestador deriva el estado de tus commits y del
  `verify` de la tarea, que corre él con `record_evidence.py`. Claves: `log` (las líneas de la entrada de LOG.md, sin
  el encabezado ni conteos de pruebas, terminadas en "Próxima acción autorizada"), y opcionales `outcome`
  (`finished` por defecto: cerrar con el verify; `unfinished`: no la terminaste; `awaiting_acceptance_approval`: tarea
  de spec cuyo diff de `tests/acceptance/` espera al usuario), `blocked_by` (en lugar de `outcome`, si debes
  detenerte), `claims` (lo que declaras, p. ej. `{"manual_pending": "qué falta verificar a mano y cómo"}`: queda como
  declaración, no como hecho), `notes` (interpretaciones, se anexan a las notas de la tarea) y `assumptions`
  (`[{"id": "S-NN", "belief", "default", "class", "trigger"}]`, filas nuevas de Supuestos en SPEC.md).
- El orquestador valida el resultado (ausente o inválido cuenta como fallo; un estado reservado detiene la corrida),
  lo aplica, corre `check:spec` y confirma `spec/` en un commit propio.

## Autoridad
- PUEDES decidir: detalles internos dentro del diseño aprobado (anótalos en el commit).
- PUEDES decidir y registrar sin preguntar: nombres internos, estructura de módulos dentro de `infra/modules/`, `ingest/` y `dataform/`, y versiones
  fijadas de herramientas y dependencias ya permitidas por R-01.
  Las globales caras de revertir van como ADR `proposed` (`node scripts/adr.mjs new`), que acepta Jev; las reversibles,
  como DEC en spec/DECISIONS.md.
- PUEDES cerrar una tarea cuyo único pendiente es una verificación manual: decláralo en `claims.manual_pending` (qué y
  cómo) y en una línea `- Pendiente manual:` de LOG.md; la evidencia automática la registra `record_evidence.py` y la
  verificación la hace el usuario al aceptar en lote.
- DEBES registrar: toda interpretación de un requisito ambiguo (supuesto en SPEC.md).
- DEBES DETENERTE Y ESCALAR: cambio de requisito, alcance o regla de negocio;
  edición de tests/acceptance/ fuera de su tarea de spec; servicio o proveedor fuera de R-01;
  desplegar o usar credenciales fuera de lo autorizado; decisión global no registrada;
  dos intentos fallidos sobre la misma falla.

## Idioma
- En inglés: código, identificadores, comentarios, nombres y descripciones de pruebas, mensajes de los scripts (terminal,
  registros de `.autopilot/`, avisos ntfy) y mensajes de commit (los trailers `Task:`/`Req:` no cambian).
- En español: todo `spec/` (SPEC.md, DECISIONS.md, TASKS.json, comentarios de `spec/contracts/`) y `spec/LOG.md`,
  incluidas las entradas que escribe el autopilot, y los informes de `research/`.
- No es código: los textos que ve el usuario del producto siguen el idioma que fije SPEC.md; AGENTS.md y README.md
  siguen en español.

## Reglas duras (verificadas por `npm run check:spec` y el hook de commit)
- No edites tests/acceptance/ en un cambio de implementación (solo tareas con `"kind": "spec"` en TASKS.json, o el
  test-author del autopilot en `tests/acceptance/<ID>*` con el trailer `Test-Author: autopilot`).
- Una tarea pasa a `done` solo con evidencia (comando + resultado + commit) en TASKS.json.
- Cada commit lleva trailers `Task:` y `Req:` (`Task: none` / `Req: none` si no aplica).
- spec/ solo contiene SPEC.md, DECISIONS.md, TASKS.json, LOG.md, contracts/ y adr/.
- No reabras una decisión `accepted` sin evidencia nueva registrada; se supersede, no se edita.
- No cambies `status` a mano (DEC-028): `verified_auto` e `implemented` los escribe `record_evidence.py`, `reviewed` la
  revisión; para el resto, `node scripts/lib/autopilot-tasks.mjs set-status T-NN <estado> --by <nombre> --reason <motivo>`
  (deja la entrada en `status_log`). Un agente solo puede fijar `in_progress` y `blocked` (DEC-032); los demás estados
  los fija el usuario, con su nombre en `--by`. Con `status_log_since` en TASKS.json, `check:spec` rechaza un cambio sin
  su entrada.
- No marques `reviewed`, `accepted` ni `approved_for_impl`: solo revisor / usuario. Excepción (DEC-022): el orquestador
  otorga `approved_for_impl` tras una crítica APROBAR, si la tarea no toca zonas sensibles.
- No subas secretos: `.env*` y credenciales fuera de git.

## Revisión independiente
Antes de `reviewed`, un revisor con contexto limpio recibe solo: diff, REQ de la tarea y DEC citadas.
Responde: ¿cada REQ implementado y probado (incluidos bordes)? ¿cambió algo fuera de alcance?
¿se violó una DEC aceptada? Sin cita a REQ/DEC, un hallazgo no bloquea. Estilo no bloquea.

## Al terminar la sesión
Commit limpio + entrada en spec/LOG.md con "Próxima acción autorizada" (en autopilot, la entrada va en el `log` del
resultado y el orquestador la escribe).
