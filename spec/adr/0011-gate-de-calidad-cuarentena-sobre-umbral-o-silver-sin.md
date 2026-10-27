# DEC-011 Gate de calidad: cuarentena sobre umbral o silver sin frescura bloquean gold

- Estado: accepted
- Fecha: 2026-10-27
- Aprobador: José Pedro
  Lübbert, 2026-10-27 (aprobación nominal en sesión)
- Módulos: dataform/definitions/assertions/assert_cuarentena_proporcion.sqlx, dataform/definitions/assertions/assert_silver_frescura.sqlx, dataform/definitions/outputs/fct_licitaciones.sqlx, dataform/workflow_settings.yaml
- Enforced-by: cmd: npm run test:dataform

## Contexto

La única alerta del pipeline era «el Workflow falló». La calidad de datos fallaba en silencio: en la primera corrida
real 932 licitaciones legítimas quedaron en cuarentena y nadie lo supo hasta contarlas; una fecha con formato nuevo
dejaría silver sin filas nuevas con el Workflow en verde. Gold se reconstruye cada noche desde silver, así que un día
así lo deja listo para consumo con datos incompletos y sin marca.

## Impulsores

REQ-008 (silver incremental), REQ-010 (cuarentena con motivo), REQ-012 (gold con `dependOnDependencyAssertions`);
pedido del usuario (sesión 2026-10-27): un gate que falle si la proporción de cuarentena del día supera un umbral y
si silver no tiene filas de la última fecha esperada, con gold bloqueado mientras falle.

## Opciones consideradas

### 1. Fail-closed: dos assertions de silver y gold depende de ellas
- A favor: una corrida con datos sospechosos no llega a gold; la invocación termina `FAILED`, el Workflow también y
  llega el correo que ya existe (REQ-007 E4). Un umbral como variable de compilación se ajusta sin tocar código.
- En contra: gold se queda con el día anterior hasta que alguien mire; un umbral mal puesto detiene el pipeline.

### 2. Fail-open: las mismas assertions como aviso, gold se reconstruye igual
- A favor: gold siempre está al día.
- En contra: es lo que ya pasaba con la cuarentena: el dato malo entra limpio y la alerta llega después, si llega.

### 3. Una métrica de cuarentena y una alerta de Monitoring, sin assertions
- A favor: no toca Dataform.
- En contra: necesita un job que publique la métrica; sigue siendo fail-open.

## Decisión

Usaremos la opción 1. `assert_cuarentena_proporcion` falla si, para la última `_ingest_date` de cada entidad de
Mercado Público, cuarentena / (silver nuevas + cuarentena) supera `umbral_cuarentena` (variable de compilación,
`0.2` por defecto). `assert_silver_frescura` falla si la última `_ingest_date` con documentos en raw de cada entidad
no aparece ni en silver ni en cuarentena. Ambas llevan la etiqueta `silver` y todos los modelos de gold las declaran
en `dependencies`, así que gold no se reconstruye mientras alguna falle. Límite conocido, anotado en la assertion de
frescura: un día en que el job no escribió nada en raw no se detecta aquí; ese caso lo cubre el fallo del job
(REQ-007 E3).

## Consecuencias

Buenas: un día con la cuarentena disparada o con silver vacío no llega a gold y avisa por correo esa misma noche.
Malas: gold queda un día atrás hasta corregir la causa y relanzar (si la cuarentena era legítima, subir el umbral con
`--vars=umbral_cuarentena=…` en una invocación manual y volver a bajarlo). Neutrales: el gate mide silver y cuarentena,
no raw, para no leer el payload; un documento bajado dos veces el mismo día cuenta una vez en silver.

## Confirmación

`npm run test:dataform` (`dataform/tests/calidad.test.mjs`): las dos assertions existen con la etiqueta `silver`,
leen silver y cuarentena de ambas entidades, todo modelo de gold depende de las dos, y el umbral entra al SQL y
rechaza valores fuera de 0..1.

## Evidencia del umbral

Con la regla de fechas anterior al PR #11 (`reglas.js` de `2c8e35e`) corrida sobre raw el 2026-10-27, la primera
corrida completa habría disparado el gate: licitaciones del `_ingest_date` 2026-10-26, 453 en silver y 932 en
cuarentena, proporción 0,673 (> 0,2); las del 2026-10-27, 11 y 11, proporción 0,5. Las órdenes no lo habrían
disparado solas (391 de 8.606, 0,045; 275 de 3.597, 0,076), pero la invocación falla con una sola assertion en rojo.

## Más información

- Revisar si: la cuarentena legítima de un día normal se acerca al 20 %; o si aparece una entidad nueva en silver
  (hay que sumarla a las dos assertions).
