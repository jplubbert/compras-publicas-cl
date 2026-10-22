# ADR (MADR) de este proyecto

Un archivo por decisión cara de revertir: `NNNN-<titulo>.md`, con el número de su DEC (`DEC-015` → `0015-…`). Lo crea
`node scripts/adr.mjs new "<título>"` en `proposed`, y lo acepta Jev con `node scripts/adr.mjs accept NNNN` (DEC-036).
Un ADR `accepted` es inmutable: solo puede cambiar su Estado a `superseded by NNNN` (check-adr lo comprueba).

```markdown
# DEC-NNN <título>

- Estado: proposed | accepted | rejected | superseded by NNNN
- Fecha: AAAA-MM-DD
- Aprobador: <persona, o Jev (modelo) con su registro de decisión>
- Módulos: <rutas que toca, separadas por comas: a los agentes se les pasa si sus touches las cruzan>
- Enforced-by: <scripts/test/x.test.mjs#DEC-NNN | cmd: <comando> | manual: <motivo>>

## Contexto
## Impulsores
## Opciones consideradas
### 1. <opción>
- A favor: …
- En contra: …
## Decisión
## Consecuencias
## Confirmación
## Más información
```
