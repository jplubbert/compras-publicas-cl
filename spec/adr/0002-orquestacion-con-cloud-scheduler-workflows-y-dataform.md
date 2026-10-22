# DEC-002 Orquestación con Cloud Scheduler, Workflows y Dataform conectado a GitHub

- Estado: proposed
- Fecha: 2026-10-22
- Aprobador: pendiente: lo acepta Jev (node scripts/adr.mjs accept 0002, DEC-036)
- Módulos: infra/, orchestration/, dataform/
- Enforced-by: cmd: npm run test:infra

## Contexto

La corrida diaria tiene que ingerir Mercado Público y Banco Central y solo después transformar en Dataform. Si la
ingesta falla, no se transforma y el fallo se ve. ChileCompra pide hacer las cargas masivas entre 22:00 y 07:00.

## Impulsores

REQ-007, DEC-001, tope de gasto (DEC-003).

## Opciones consideradas

### 1. Cloud Scheduler → Workflows → Cloud Run Jobs → API de Dataform (repositorio conectado a GitHub)
- A favor: es el patrón documentado por Google para Dataform; muestra el servicio Dataform nativo, con su grafo y sus
  logs de ejecución; Workflows encadena los pasos y corta si uno falla; Scheduler (3 jobs) y Workflows (5.000 pasos al
  mes) caben en el free tier.
- En contra: el repositorio Dataform necesita un token de GitHub de solo lectura en Secret Manager.

### 2. Cloud Scheduler → Workflows → Cloud Run Job que corre la CLI de Dataform
- A favor: no necesita token de GitHub.
- En contra: no usa el servicio Dataform; se pierde el grafo y el historial de ejecución en la consola; hay que mantener
  una imagen más.

### 3. Programación nativa de Dataform (workflow config) más un Scheduler aparte para la ingesta
- A favor: es la configuración más simple.
- En contra: no hay dependencia real: Dataform corre aunque la ingesta haya fallado.

## Decisión

Usaremos la opción 1. Un job de Cloud Scheduler (23:30 America/Santiago) lanza un Workflow que ejecuta el Cloud Run Job
de Mercado Público, después el de Banco Central y mindicador, y luego compila Dataform desde `main` y lanza la
invocación con las etiquetas `silver` y `gold`. Si un paso falla, el Workflow termina en error y una política de
alertas avisa por correo. Aceptamos mantener un token de GitHub fine-grained de solo lectura (DEC-004).

## Consecuencias

Buenas: un paso falla y los siguientes no corren; la ejecución se puede ver en la consola de Dataform. Malas: un secreto
más que rotar. Neutrales: el horario se cambia con una variable de Terraform.

## Confirmación

Las pruebas `terraform test` de T-11 comprueban el Scheduler, el Workflow y su orden. La primera corrida real queda en
el `verify_integration` de T-11.

## Más información

- Revisar si: Dataform pasa a permitir repositorios sin remoto git para las invocaciones, o Workflows deja de ser
  gratis a este volumen.
