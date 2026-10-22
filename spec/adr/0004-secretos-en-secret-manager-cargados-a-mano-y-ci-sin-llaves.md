# DEC-004 Secretos en Secret Manager cargados a mano y CI sin llaves

- Estado: proposed
- Fecha: 2026-10-22
- Aprobador: pendiente: lo acepta Jev (node scripts/adr.mjs accept 0004, DEC-036)
- Módulos: infra/, .github/workflows/, ingest/
- Enforced-by: cmd: npm run check:repo

## Contexto

Hay cuatro credenciales: el ticket de Mercado Público (se obtiene con Clave Única), el usuario y la clave de la BDE del
Banco Central, y el token de GitHub de Dataform (DEC-002). CI tiene que desplegar en GCP. Un repo público de portafolio
no puede filtrar ninguna.

## Impulsores

REQ-002, REQ-004, REQ-005, DEC-002.

## Opciones consideradas

### 1. Terraform crea los secretos vacíos y el usuario carga los valores con gcloud; CI se autentica con Workload Identity Federation
- A favor: ningún valor queda en el estado de Terraform ni en git; no hay llaves de cuenta de servicio; es el patrón que
  recomienda Google.
- En contra: hay un paso manual al configurar el proyecto.

### 2. Valores como variables sensibles de Terraform y llave JSON de la cuenta de servicio en los secretos de GitHub
- A favor: todo queda automatizado.
- En contra: los valores quedan en el estado de Terraform y la llave JSON es de larga vida; un evaluador lo nota.

## Decisión

Usaremos la opción 1. Terraform declara `google_secret_manager_secret` sin versiones. El usuario agrega las versiones
(README, «Reproducir»). Los jobs leen el secreto en tiempo de ejecución con su propia cuenta de servicio. GitHub Actions
usa `google-github-actions/auth` con WIF, restringido por `attribute.repository` al repo. Ningún secreto se escribe en
logs, en GCS ni en BigQuery: la URL guardada en bronze lleva el ticket redactado.

## Consecuencias

Buenas: no hay secretos en el repo ni en el estado. Malas: un paso manual documentado. Neutrales: rotar un secreto es
agregarle una versión.

## Confirmación

`npm run check:repo` falla si encuentra `credentials_json`, una llave de cuenta de servicio o un
`google_secret_manager_secret_version` con datos. Las pruebas de ingesta comprueban que el ticket no aparece en la salida
ni en los registros.

## Más información

- Revisar si: ChileCompra cambia la autenticación de su API.
