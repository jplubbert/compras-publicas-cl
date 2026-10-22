# DEC-003 Tope de gasto duro con presupuesto, desvinculación de billing y cuotas

- Estado: proposed
- Fecha: 2026-10-22
- Aprobador: pendiente: lo acepta Jev (node scripts/adr.mjs accept 0003, DEC-036)
- Módulos: infra/bootstrap/, infra/, finops/
- Enforced-by: cmd: npm run test:finops

## Contexto

El proyecto usa billing activo (el sandbox de BigQuery no permite MERGE). Los presupuestos de GCP solo avisan, y el aviso
puede llegar horas tarde. El usuario pidió un corte duro de USD 10 (sesión 2026-10-21).

## Impulsores

REQ-003, R-03, DEC-001.

## Opciones consideradas

### 1. Presupuesto de USD 10 + Pub/Sub + función que desvincula el billing al 100 %, cuotas de BigQuery y `maximum_bytes_billed`
- A favor: es el único corte real que documenta Google; las cuotas frenan antes el caso más probable (una query cara).
- En contra: si salta, todo el proyecto se detiene hasta revincularlo a mano. Además, el dato de costo llega con
  retraso, así que se puede pasar algo de USD 10.

### 2. Solo avisos de presupuesto y cuotas
- A favor: no hay riesgo de apagar el proyecto.
- En contra: no corta un gasto fuera de BigQuery.

## Decisión

Usaremos la opción 1. El presupuesto (alertas al 50, 90 y 100 % del gasto real), el tema de Pub/Sub y la función
desvinculadora (`finops/killswitch/`, Cloud Run function en Python) viven en `infra/bootstrap/`, que aplica el usuario a
mano con sus credenciales. La cuenta de servicio de CI no recibe permisos sobre el billing, así que no puede quitar el
tope. En `infra/` principal van la cuota diaria de bytes de query de BigQuery (S-07) y `maximum_bytes_billed` por
defecto en Dataform y en las consultas de los scripts (los load jobs no facturan bytes). Aceptamos que el corte detenga el proyecto.

## Consecuencias

Buenas: un error no cuesta más de unos dólares sobre el tope. Malas: hay que revincular el billing a mano tras un corte;
la cuenta de servicio de CI necesita `roles/run.admin` para desplegar los jobs, y con él podría modificar la función
desvinculadora (también es un servicio de Cloud Run). Es un riesgo residual aceptado: CI no tiene roles de billing ni
de Pub/Sub, y el README lo declara.
Neutrales: el monto es una variable (por defecto 10).

## Confirmación

`npm run test:finops` prueba la función con mensajes de ejemplo. `terraform test` comprueba el presupuesto, los umbrales
y que la cuenta de servicio de CI no tenga roles de billing. El disparo real queda en el `verify_integration` de T-05,
con un presupuesto de prueba de USD 0,01 en un proyecto desechable.

## Más información

- Revisar si: Google ofrece un tope de gasto nativo por proyecto.
