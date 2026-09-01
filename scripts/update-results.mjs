// Actualiza en directo los partidos de la jornada abierta: marcador, fase,
// minuto, goles y tarjetas. Escribe SOLO la fila del partido y sus eventos.
// Un partido con finished=true no se vuelve a tocar (solo el admin puede reabrirlo).

import { db } from './lib/supabase.mjs';
import { providers } from './lib/providers.mjs';
import { minutesSince } from './lib/time.mjs';

const LOOP_MS = 3 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const DEADLINE = Date.now() + 190 * 60 * 1000; // el job tiene timeout de 200 min
const WINDOW_BEFORE = -10, WINDOW_AFTER = 300; // minutos respecto al kickoff

async function syncMatch(match) {
  const provider = providers[match.provider];
  if (!provider || !match.provider_event_id) { console.log('  sin proveedor/evento; solo manual'); return false; }
  const live = await provider.live(match.provider_event_id);
  const patch = {
    phase: live.phase,
    minute: live.minute,
    finished: live.finished,
    updated_by: 'workflow',
  };
  if (live.homeScore !== null && live.awayScore !== null) {
    patch.home_score = live.homeScore;
    patch.away_score = live.awayScore;
  }
  await db.update('matches', `id=eq.${match.id}&finished=eq.false`, patch);
  if (live.events.length) {
    await db.remove('match_events', `match_id=eq.${match.id}`);
    await db.insert('match_events', live.events.map((e) => ({ ...e, match_id: match.id })));
  }
  const score = live.homeScore === null ? '–' : `${live.homeScore}-${live.awayScore}`;
  console.log(`  ${live.finished ? 'FINAL' : live.phase.toUpperCase()} ${score}${live.minute ? ` min ${live.minute}` : ''} | ${live.events.length} eventos`);
  return !live.finished;
}

async function cycle() {
  console.log('\n=== Sondeo', new Date().toISOString(), '===');
  const rounds = await db.select('rounds', 'status=neq.closed&select=id,label,status&order=created_at.desc&limit=1');
  if (!rounds.length) { console.log('No hay jornada abierta.'); return 0; }
  const round = rounds[0];
  const matches = await db.select('matches', `round_id=eq.${round.id}&order=kickoff.asc`);
  let pending = 0, anyLive = false;
  for (const m of matches) {
    console.log(`--- ${m.home_team} vs ${m.away_team} (${m.provider}) ---`);
    if (m.finished) { console.log(`  ya finalizado: ${m.home_score}-${m.away_score}`); continue; }
    const mins = minutesSince(new Date(m.kickoff));
    if (mins < WINDOW_BEFORE) { console.log(`  empieza en ${Math.round(-mins)} min`); pending++; continue; }
    if (mins > WINDOW_AFTER) { console.log(`  fuera de ventana (${Math.round(mins)} min); lo cierra el admin`); continue; }
    try {
      const stillLive = await syncMatch(m);
      if (stillLive) { pending++; anyLive = true; }
    } catch (e) {
      console.log(`  ERROR proveedor: ${e.message}`); pending++;
    }
  }
  if (anyLive && round.status === 'open') await db.update('rounds', `id=eq.${round.id}`, { status: 'live' });
  // Solo cuenta como pendiente lo que está en juego o a punto de empezar
  return matches.filter((m) => !m.finished && minutesSince(new Date(m.kickoff)) > -60 && minutesSince(new Date(m.kickoff)) < WINDOW_AFTER).length;
}

// GitHub descarta la mayoría de las ejecuciones de un cron '*/5'. Cada ejecución
// sondea en bucle mientras haya partidos en juego para cubrir ese hueco.
async function loop() {
  let errors = 0;
  while (true) {
    let pending = 0, failed = false;
    try { pending = await cycle(); }
    catch (e) { failed = true; errors++; console.error(`Error en ciclo (${errors}):`, e.message || e); }
    if (failed) {
      if (errors >= 15 || Date.now() + RETRY_MS > DEADLINE) { console.log('Fin por errores/tiempo.'); return; }
      await new Promise((r) => setTimeout(r, RETRY_MS));
      continue;
    }
    errors = 0;
    if (!pending) { console.log('\nNada en juego: fin.'); return; }
    if (Date.now() + LOOP_MS > DEADLINE) { console.log('\nLímite de la ejecución.'); return; }
    console.log(`\n${pending} partido(s) pendientes; siguiente sondeo en 3 min.`);
    await new Promise((r) => setTimeout(r, LOOP_MS));
  }
}

loop().catch((e) => { console.error('Error fatal:', e.message || e); process.exit(1); });
