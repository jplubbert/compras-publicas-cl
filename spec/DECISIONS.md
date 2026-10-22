# Registro de decisiones

<!--
DEC-035 (sdd-base): las decisiones caras de revertir (las que cambian el contrato de spec/, un límite de autoridad o
seguridad, el stack o la arquitectura) son ADR en spec/adr/NNNN-<titulo>.md, con el formato de spec/adr/README.md:
nacen `proposed` (node scripts/adr.mjs new "<título>") y las acepta Jev (node scripts/adr.mjs accept NNNN, DEC-036).
Un ADR aceptado no se edita: se supersede con uno nuevo, y el viejo pasa a "superseded by NNNN".
Las reversibles (se apagan con una opción o tocan un solo componente) van como `## DEC-NNN` debajo del índice:

## DEC-NNN <título como frase nominal>
- Estado: proposed | accepted | rejected | superseded by DEC-NNN
- Alcance: global | local
- Fecha: <AAAA-MM-DD> · Aprobador: <persona o rol> · Confianza: alta | media | baja
- Problema: <contexto y fuerzas, neutral>
- Alternativas consideradas:
  1. <A> — a favor: … ; en contra: …
- Decisión: Usaremos <X> y no <Y>, para lograr <beneficio>, aceptando <costo>.
- Consecuencias: buenas: … ; malas: … ; neutrales: …
- Confirmación: <prueba o chequeo que la verifica>
- Revisar si: <condición concreta que reabre la decisión>

El índice lo genera `node scripts/adr.mjs index`; check-adr falla si no está al día.
-->

<!-- adr-index:start -->
<!-- generado por `node scripts/adr.mjs index`; no se edita a mano (DEC-035) -->

| ID | Título | Estado | Dónde |
|---|---|---|---|

<!-- adr-index:end -->

## Decisiones reversibles (no migradas a ADR, DEC-035)
