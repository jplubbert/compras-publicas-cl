# DEC-009 Ajustes del spike T-02 a DEC-002, DEC-003 y DEC-004

- Estado: proposed
- Fecha: 2026-10-22
- Aprobador: pendiente: lo acepta José Pedro Lübbert
- Módulos: package.json
- Enforced-by: manual: lo comprueban las pruebas de T-05 (cuotas), T-07 (token de la BDE) y T-11 (repositorio Dataform)

## Contexto

El spike T-02 (docs/spikes/T-02-recursos.md) encontró tres hechos que contradicen el texto de ADR ya aceptados, que no
se pueden editar: (1) Dataform no tiene un campo `maximumBytesBilled` (DEC-003 lo pone «por defecto en Dataform»); (2) la
API REST de la BDE se autentica con un token, no con usuario y clave (DEC-004 nombra «el usuario y la clave de la BDE»);
(3) la guía de Dataform pide que el token de GitHub tenga Contents: read and write (DEC-002 dice «de solo lectura»).
Además, la guía oficial de desvinculación da a la función `roles/billing.admin` sobre la cuenta de facturación, y avisa
que al quitar el billing se pueden borrar recursos.

## Impulsores

REQ-003, REQ-005, REQ-007; DEC-002, DEC-003, DEC-004; T-02.

## Opciones consideradas

### 1. Un ADR que complementa a los tres y manda donde chocan
- A favor: los tres ADR siguen vigentes en todo lo demás; un solo lugar documenta lo que cambió y por qué.
- En contra: para entender cada decisión hay que leer dos ADR.

### 2. Reemplazar (superseder) DEC-002, DEC-003 y DEC-004 por tres ADR nuevos completos
- A favor: cada decisión queda en un solo archivo.
- En contra: se copian tres ADR casi iguales para cambiar una frase en cada uno.

## Decisión

Usaremos la opción 1. Donde chocan con DEC-002, DEC-003 o DEC-004, manda esto:
- DEC-003: el tope por consulta de Dataform es la cuota diaria por usuario `QueryUsagePerUserPerDay`, que alcanza a su
  cuenta de servicio (además de la de proyecto `QueryUsagePerDay`). `maximum_bytes_billed` queda solo en las consultas de
  los scripts. La desvinculadora prueba primero `roles/billing.projectManager` sobre el proyecto y, si el simulacro de
  T-05 falla, usa `roles/billing.admin` sobre la cuenta de facturación. Se agrega a las consecuencias que, al quitar el
  billing, se pueden borrar recursos.
- DEC-004: el secreto de la BDE es su token de API, no un usuario y una clave.
- DEC-002: el token de GitHub de Dataform es fine-grained, limitado al repo, con Contents: read and write (lo que pide la
  guía de Dataform), y con caducidad.

## Consecuencias

Buenas: las tareas T-05, T-07 y T-11 implementan algo que existe. Malas: el token de GitHub puede escribir en el repo
(limitado a ese repo y con caducidad). Neutrales: REQ-003, REQ-005 y S-07 ya se ajustaron (LOG 2026-10-22).

## Confirmación

Las pruebas `terraform test` de T-05 comprueban las dos cuotas; las de T-07, que el token no aparece en la salida; y el
`verify_integration` de T-05, el rol que basta para desvincular.

## Más información

- Fuente: docs/spikes/T-02-recursos.md, secciones (a), (c), (e), Banco Central y Supuestos.
- Revisar si: Dataform agrega un tope de bytes por invocación.
