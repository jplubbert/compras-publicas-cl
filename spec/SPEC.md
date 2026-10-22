# SPEC — <proyecto>
Versión: 1  ·  Corte 1: draft  ·  Nivel de riesgo (sdd.md §10.4): <bajo | funcionalidad mediana | alto>

<!--
Variante "desarrollador único" de PCR: el Plan vive en este archivo (sección Plan) en vez de spec/PLAN.md.
Solo anexar cambios con contexto: un requisito cambiado conserva "(Previamente: …, cambiado en LOG <fecha>)".
Estados de un requisito: proposed → approved_for_impl (lo marca el usuario) → … (sdd.md §8.2).
-->

## Objetivo (≤1 página)
Para <actor>, que necesita <resultado>, el sistema <beneficio observable>.
¿Y qué?: <por qué es mejor que la alternativa actual>.
Criterio de éxito: <medida observable>.

## Alcance
- Incluido (corte 1): <recorrido / capacidades>
- Excluido explícitamente: <lista>
- Cortes futuros: <lista, sin detalle>

## Restricciones
<!-- - R-01 <técnica, legal, presupuesto, plazo> — fuente: <usuario | norma | DEC-NNN> -->

## Glosario
<!-- - <término>: <definición única> -->

## Requisitos
<!--
Formato de cada requisito (el encabezado con número real es el que cuenta para check:spec):

### REQ-NNN <título> · estado: proposed · prioridad: must | should | could
Cuando <disparador>, el sistema deberá <respuesta>.
Si <condición no deseada>, entonces el sistema deberá <respuesta>.
Ejemplos (aceptación):
| caso | entrada / contexto | resultado esperado |
|---|---|---|
| E1 positivo | … | … |
| E2 negativo | … | … |
| E3 borde | … | … |
Trazas: objetivo §Objetivo · decisiones: DEC-NNN · prueba: tests/acceptance/req_NNN_*
-->

## Supuestos (no bloqueantes, con valor por defecto)
| ID | creemos que… | valor por defecto | clase | disparador de revisión |
|---|---|---|---|---|

## Preguntas abiertas
| ID | pregunta | clase (bloqueante/costosa/spike/diferible) | bloquea a | responsable | vence |
|---|---|---|---|---|---|

## Plan (corte 1)
### Diseño
<!-- Componentes, contratos (spec/contracts/), decisiones globales que aplica (DEC-NNN). -->

### Orden y dependencias
<!-- 1. T-01 Esqueleto andante — ejercita las decisiones globales de punta a punta (sin dependencias) -->

### Riesgos y spikes
| riesgo | mitigación |
|---|---|

## Criterio de cierre del corte (declarado antes del análisis)
- [ ] Objetivo y exclusiones confirmados por el responsable
- [ ] Cada REQ con ID, ≥1 ejemplo positivo y ≥1 negativo/borde
- [ ] Sin preguntas bloqueantes/costosas abiertas que el corte consuma
- [ ] Decisiones globales consumidas en `accepted` o con spike en curso
- [ ] Conjunto coherente: objetivo→REQ→ejemplo, sin conflictos, glosario
- [ ] Revisión independiente sin bloqueos nuevos
- Presupuesto del bloque: <sesiones / horas>; al agotarse: cortar | spike | diferir
