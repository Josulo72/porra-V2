# La Porra de Supervivencia v2

Porra de fútbol entre amigos: 3 partidos por fin de semana (Real Madrid, FC Barcelona, SD Ponferradina), marcador exacto, muerte súbita.

- **Documento de diseño y normas de trabajo:** [`CLAUDE.md`](CLAUDE.md). Es el contrato del proyecto.
- **Base de datos:** Supabase, proyecto `porra-v2` (región eu-west-3). Esquema en [`supabase/migrations`](supabase/migrations), tests en [`supabase/tests`](supabase/tests).
- **Front:** React + Vite estático en GitHub Pages (pendiente, fase 3).
- **Resultados:** GitHub Actions (ESPN para Madrid y Barça, Sofascore para la Ponfe) (pendiente, fase 2).

## Estado

| Fase | Estado |
|---|---|
| 1. Esquema, RLS, lógica de eliminación y tests | Aplicada en Supabase y verificada |
| 2. Workflows de carga de jornada y resultados | Pendiente |
| 3. Front | Pendiente |
