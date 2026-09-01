# La Porra de Supervivencia v2 — Documento de diseño

Este documento es el contrato del proyecto. Cualquier decisión que no esté aquí se pregunta a Jorge antes de implementarla. Nada de lo que está aquí se reinterpreta.

## 1. Qué es

Web app para un grupo de amigos que sigue una porra de supervivencia de fútbol. Cada fin de semana hay 3 partidos fijos: Real Madrid, FC Barcelona y SD Ponferradina. Cada participante pronostica el marcador exacto de los tres. Muerte súbita: el primer partido (por orden cronológico real) en el que fallas, quedas eliminado. Sobrevive quien acierta los tres.

La porra oficial la gestiona un bar. Esta app no es vinculante: sirve para que el grupo tenga el estado controlado y bonito.

## 2. Decisiones cerradas

- **Coste cero.** Ningún servicio de pago. Si algo exige pagar, se descarta.
- **Sin notificaciones.** Ni Telegram, ni WhatsApp, ni push, ni email. Nada.
- **Un solo almacén:** Supabase (Postgres). No hay Apps Script, ni localStorage como fuente de verdad, ni JSON compartido.
- **Un solo escritor de resultados:** el workflow de GitHub Actions. El admin puede corregir a mano desde el panel. Nadie más escribe resultados.
- **Cada participante escribe solo sus pronósticos**, y solo hasta la hora de kickoff de cada partido. El bloqueo lo aplica el servidor (RLS), no el reloj del navegador.
- **La eliminación se calcula en servidor** (función Postgres), nunca en el cliente.
- **Fuentes de datos:** ESPN (API pública no oficial `site.api.espn.com`) para Real Madrid y FC Barcelona; Sofascore (API no oficial) para SD Ponferradina (Primera Federación, grupo 1). TheSportsDB, Flashscore, API-Football y cualquier scraping desde el navegador quedan fuera.
- **Sin límite de participantes.** Alta libre por nombre desde la web; el admin puede añadir, quitar y corregir.
- **Solo partidos de fin de semana:** sábado, domingo y lunes (hora de Madrid). Los de viernes y de entre semana se saltan al cargar la jornada.
- **Diseño de nivel premio.** El objetivo visual es una pieza que pudiera presentarse a un premio de diseño web (tipo Awwwards): identidad propia, tipografía con carácter, movimiento con intención, detalle en cada estado. No se parte de la app anterior ni se hace una variación de ella: se diseña desde cero. Jorge quiere ver inventiva, no continuidad. Ver sección 7.

## 3. Arquitectura

```
GitHub Pages (React estático)  <--realtime-->  Supabase (Postgres + Auth + RLS)
                                                        ^
GitHub Actions (load-round, update-results) ------------+  (service role key, secret)
                     |
          ESPN API  /  Sofascore API
```

- Front: React + Vite, build estático desplegado en GitHub Pages. Sin Babel en el navegador, sin Tailwind por CDN.
- Supabase: proyecto gratuito. Realtime para que el marcador y la lista de vivos se actualicen sin recargar.
- Workflows: Node en GitHub Actions, escriben en Supabase con la service role key guardada como secret. Nunca en el repo.

## 4. Modelo de datos

**rounds** — una jornada
- id, label (texto, ej. "Jornada 3"), status (`open` | `live` | `closed`), created_at

**matches** — 3 por jornada
- id, round_id, slot (1..3, orden de aparición fijo: Madrid, Barça, Ponfe), home_team, away_team, home_logo, away_logo, kickoff (timestamptz, guardado en UTC, mostrado en Europe/Madrid), provider (`espn` | `sofascore`), provider_event_id
- home_score, away_score (null hasta que haya marcador)
- phase (`pre` | `first_half` | `halftime` | `second_half` | `finished`), minute
- finished (boolean). Cuando es true, el workflow no vuelve a tocar el partido. Solo el admin puede ponerlo a false.
- updated_at, updated_by (`workflow` | `admin`)

**match_events** — goles y tarjetas
- id, match_id, minute, type (`goal` | `yellow` | `red`), player, side (`home` | `away`)

**participants**
- id, name (único por jornada, sin distinguir mayúsculas), round_id, paid (boolean), created_at

**predictions** — una por participante y partido
- participant_id, match_id, home, away, locked_at
- RLS: solo se puede insertar/actualizar si `now() < matches.kickoff` del partido.

**settings** — una fila
- pot (bote actual en euros), admin_note

## 5. Reglas de eliminación (función `evaluate_round(round_id)`)

1. Ordenar los partidos de la jornada por `kickoff` real, no por slot.
2. Para cada participante, recorrer los partidos en ese orden. Solo cuentan los partidos con `finished = true`.
3. Si en un partido finalizado no tiene pronóstico, o el pronóstico no coincide exactamente con el marcador: eliminado en ese partido. Se para.
4. Si supera todos los finalizados: vivo.
5. Un partido no finalizado no elimina a nadie, aunque tenga marcador parcial.

Devuelve, por participante: `status` (`alive` | `eliminated`), `eliminated_at_match_id`.

Esta función lleva tests. Casos mínimos: los tres aciertos; fallo en el 1º; fallo en el 3º con el 3º jugado antes que el 1º; sin pronóstico en un partido finalizado; marcador parcial de partido en juego (no elimina); jornada sin partidos finalizados (todos vivos).

## 6. Workflows

**load-round.yml** — carga la siguiente jornada
- Se lanza a mano desde el panel de admin (botón "Nueva jornada") y por cron el lunes de madrugada.
- Para cada equipo busca el próximo partido en los siguientes 10 días que caiga en sábado, domingo o lunes (hora de Madrid). Los de viernes y de entre semana se saltan.
- Madrid y Barça: ESPN. Ponfe: Sofascore.
- Crea la fila en `rounds` y las tres en `matches` con escudos y `provider_event_id`. No borra la jornada anterior: la cierra (`status = closed`).

**update-results.yml** — resultados en directo
- Cron cada 5 min de sábado a lunes en horario de partidos, con bucle interno de 3 min mientras haya partidos en juego (GitHub descarta la mayoría de ejecuciones de cron; el bucle cubre el hueco).
- Para cada partido de la jornada abierta con `finished = false` y kickoff en ventana [-10 min, +300 min]: consulta su proveedor por `provider_event_id`, escribe marcador, fase, minuto, eventos y `finished` si el proveedor lo da por terminado.
- Escribe **solo su fila** (`update ... where id = ...`). Nunca lee ni escribe participantes ni pronósticos.
- Si el proveedor no responde, lo registra y sigue. No inventa datos.

Del repo anterior solo se reutiliza la lógica de consulta a ESPN y Sofascore de `update-results.yml`, incluida la conversión de zona horaria. Nada más se lee ni se copia.

## 7. Front

### Dirección de diseño

- Nivel objetivo: candidata a premio (Awwwards, FWA, CSS Design Awards). Se juzga con ese listón.
- Libertad creativa total en concepto, paleta, tipografía, composición y movimiento. No hay paleta ni tipografía heredada; la app anterior no se abre ni como referencia.
- Se espera propuesta: antes de codificar la UI, presentar a Jorge 2 o 3 direcciones visuales distintas (concepto en una frase, paleta, tipografías, una pantalla clave ilustrada) y que él elija. Solo entonces se implementa.
- Movimiento con sentido: transiciones de estado (gol, eliminación, final de partido), micro-interacciones, carga inicial. Animaciones fluidas a 60 fps en móvil; `prefers-reduced-motion` respetado.
- Usar todas las skills y plugins de diseño disponibles, no solo `frontend-design`: `canvas-design`, `theme-factory`, `algorithmic-art` (por ejemplo para fondos generativos o ilustración), `web-artifacts-builder` y cualquier plugin instalado que aporte. Mezclarlas si hace falta. Antes de empezar la fase de front, listar cuáles se van a usar y para qué.
- Mobile first: la mayoría lo verá en el móvil desde el bar. Pero el escritorio también tiene que impresionar.
- Cero componentes genéricos de librería sin personalizar. Nada que parezca una plantilla.

### Pantallas

Una sola pantalla pública y un panel de admin.

**Pública**
- Cabecera con bote y supervivientes vivos / total.
- Tres tarjetas de partido: escudos, marcador grande, minuto y fase (previa / 1ª parte / descanso / 2ª parte / final), cuenta atrás si no ha empezado, lista de goles y tarjetas con minuto y jugador.
- Lista de participantes con estado (vivo / eliminado y en qué partido), sus tres pronósticos y si ha pagado.
- Botón "Mi pronóstico": alta por nombre y edición de los tres marcadores hasta el kickoff de cada uno; los ya bloqueados se ven pero no se editan.

**Admin** (login real de Supabase Auth, un solo usuario)
- Corregir marcador, fase y `finished` de cada partido.
- Añadir, quitar y corregir participantes; marcar pagados; editar bote.
- "Nueva jornada": cierra la actual y lanza `load-round`.
- Importar participantes desde Excel/JSON (mismo formato que la app anterior).

## 8. Fuera de alcance

Notificaciones de cualquier tipo. Apps Script. TheSportsDB. Scraping desde el navegador. Service worker. Multi-grupo. Histórico de jornadas en la UI (los datos se conservan; la vista queda para más adelante).

## 9. Cómo se trabaja en este repo

- Antes de tocar nada, plan mode. El plan lo elabora Claude Code (fases, tareas, qué skill o plugin usa en cada una, cómo se verifica cada entrega) y Jorge lo aprueba. Sin plan aprobado no se escribe nada.
- Las skills y plugins instalados se usan de verdad, no se mencionan. Al arrancar cada fase, revisar cuáles aplican (`skill-creator`, `codex:review` para revisión de código, `auditor-externo` al cerrar cada fase, las de diseño en el front) e invocarlas explícitamente. Si una skill aplica y no se usa, es un fallo de la tarea.
- Cada fase termina con una auditoría con la skill `auditor-externo`: lo pedido contra lo que existe. El informe se entrega a Jorge antes de pasar a la siguiente fase.
- Orden de fases, sin saltarse ninguna:
  1. Esquema Supabase, RLS y función `evaluate_round` con sus tests. Nada de UI hasta que los tests pasen.
  2. Workflows contra Supabase, probados con un partido real.
  3. Front: primero las 2-3 direcciones visuales para que Jorge elija; después cada pantalla se enseña antes de darla por buena.
- Un commit por cambio lógico. `Code`, workflows y front nunca en el mismo commit.
- Nunca se modifica `.claude/`, `CLAUDE.md` ni los hooks. Si un hook bloquea, se para y se pregunta.
- "Hecho" significa: tests pasando, comprobado en el navegador o en el log del workflow, y enseñado. Nunca antes.
- No se instala ninguna dependencia ni servicio de pago.
- Las claves (service role, admin) van en secrets de GitHub o en `.env` ignorado por git. Nunca en el código.
