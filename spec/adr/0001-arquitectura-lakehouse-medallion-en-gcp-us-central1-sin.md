# DEC-001 Arquitectura lakehouse medallion en GCP us-central1 sin Composer

- Estado: accepted
- Fecha: 2026-10-22
- Aprobador: José Pedro Lübbert (aprobación nominal del corte 1 en sesión, 2026-10-21)
- Módulos: package.json
- Enforced-by: manual: el chequeo `npm run check:repo` lo crea su tarea; se cambia a `cmd: npm run check:repo` cuando exista

## Contexto

El proyecto es un repo de portafolio para postular a roles de data engineer GCP del tipo consultora (BigQuery, Dataform,
Cloud Run, Terraform, CI/CD, gobierno, calidad y FinOps). Tiene que costar entre USD 0 y 1 al mes y verse como trabajo
de producción. Ingiere a diario Mercado Público y Banco Central.

## Impulsores

REQ-001, REQ-003, REQ-008, REQ-012; informe «Proyecto portafolio data engineer GCP» (propuesta A); pedido del usuario:
sin Composer.

## Opciones consideradas

### 1. Medallion: GCS (bronze) → BigQuery raw → Dataform (silver/gold), Cloud Run Jobs en Python, us-central1
- A favor: los batch loads a BigQuery y Dataform son gratis; GCS tiene free tier solo en regiones US; el SQL en Dataform es el núcleo que piden los avisos; un solo lenguaje de transformación.
- En contra: los datos chilenos quedan en EE. UU. (son públicos, no importa); Dataform es menos conocido que dbt.

### 2. Igual, pero con dbt Core en un Cloud Run Job
- A favor: dbt es más conocido y tiene más ecosistema.
- En contra: en los avisos objetivo aparece solo como «ideal»; agrega un runtime más y no muestra Dataform.

### 3. Composer (Managed Service for Apache Airflow) + Dataflow
- A favor: es el arquetipo bancario.
- En contra: Composer cuesta cerca de USD 300 al mes mientras el environment exista; rompe el tope de USD 10.

### 4. Región southamerica-west1 (Santiago)
- A favor: latencia y residencia local.
- En contra: sin free tier de GCS y más cara para BigQuery.

## Decisión

Usaremos la opción 1: bronze en GCS (`us-central1`), datasets BigQuery `raw`, `silver`, `gold` y `quarantine` en
`us-central1`, transformación en Dataform (`definitions/sources` → `intermediate` → `outputs`), ingesta en Cloud Run
Jobs (Python 3.12, uv) y todo declarado en Terraform. No se crea ningún `google_composer_environment`. Aceptamos usar
Dataform en vez de dbt.

## Consecuencias

Buenas: costo cercano a cero; cada capa tiene su dataset y sus criterios de promoción. Malas: la corrida diaria pasa
por EE. UU. Neutrales: si se quiere mostrar Airflow, se levanta local en Docker, fuera del repo desplegado.

## Confirmación

`npm run check:repo` (lo crea T-01; T-04 lo corre en CI) falla si `infra/` declara `google_composer_environment` o si
un recurso regional usa otra región que `var.region`. Las pruebas de `terraform test` de T-03 comprueban las
ubicaciones.

## Más información

- Revisar si: el free tier de GCS o BigQuery cambia de regiones, o un aviso objetivo exige dbt.
