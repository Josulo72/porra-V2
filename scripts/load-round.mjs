// Carga la siguiente jornada: el próximo partido de cada equipo que caiga en
// sábado, domingo o lunes (hora de Madrid) dentro de los próximos 10 días.
// Cierra la jornada abierta anterior. Nunca toca participantes ni pronósticos.

import { db } from './lib/supabase.mjs';
import { providers } from './lib/providers.mjs';
import { isWeekendMatch, madridWeekday, madridDateLabel } from './lib/time.mjs';

const FORCE = process.env.FORCE === 'true';
const TEAMS = [
  { slot: 1, name: 'Real Madrid',     provider: 'espn',      teamId: '86' },
  { slot: 2, name: 'FC Barcelona',    provider: 'espn',      teamId: '83' },
  { slot: 3, name: 'SD Ponferradina', provider: 'sofascore', teamId: '6195' },
];
const HORIZON_MS = 10 * 86400e3;

async function pickNext(team) {
  const list = await providers[team.provider].upcoming(team.teamId);
  const now = Date.now();
  for (const m of list) {
    if (m.kickoff.getTime() < now - 2 * 3600e3) continue;
    if (m.kickoff.getTime() > now + HORIZON_MS) break;
    if (!isWeekendMatch(m.kickoff)) {
      console.log(`  (saltado ${madridDateLabel(m.kickoff)} ${madridWeekday(m.kickoff)}: no es sábado/domingo/lunes)`);
      continue;
    }
    return m;
  }
  return null;
}

async function main() {
  console.log('=== Carga de jornada ===', new Date().toISOString());
  const open = await db.select('rounds', 'status=neq.closed&select=id,label,status,matches(id,kickoff,finished)&order=created_at.desc&limit=1');
  const current = open[0];
  if (current && !FORCE) {
    const pending = (current.matches || []).some((m) => !m.finished && Date.now() - new Date(m.kickoff).getTime() < 4.5 * 3600e3);
    if (pending) {
      console.log(`Jornada "${current.label}" aún tiene partidos por jugar. No se carga otra (usa force=true para forzar).`);
      return;
    }
  }

  const found = [];
  for (const team of TEAMS) {
    console.log(`\n${team.name} (${team.provider}):`);
    try {
      const m = await pickNext(team);
      if (!m) { console.log('  sin partido de fin de semana en los próximos 10 días'); continue; }
      console.log(`  ${m.homeTeam} vs ${m.awayTeam} — ${m.kickoff.toISOString()}`);
      found.push({ team, m });
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }
  if (!found.length) { console.log('\nNada que cargar.'); return; }

  if (current) {
    await db.update('rounds', `id=eq.${current.id}`, { status: 'closed' });
    console.log(`\nJornada anterior "${current.label}" cerrada.`);
  }

  const dates = found.map((f) => f.m.kickoff).sort((a, b) => a - b);
  const label = `${madridDateLabel(dates[0])} – ${madridDateLabel(dates[dates.length - 1])}`;
  const [round] = await db.insert('rounds', [{ label, status: 'open' }]);
  const rows = found.map(({ team, m }) => ({
    round_id: round.id,
    slot: team.slot,
    home_team: m.homeTeam,
    away_team: m.awayTeam,
    home_logo: m.homeLogo,
    away_logo: m.awayLogo,
    kickoff: m.kickoff.toISOString(),
    provider: team.provider,
    provider_event_id: m.providerEventId,
    updated_by: 'workflow',
  }));
  await db.insert('matches', rows);
  console.log(`\nJornada "${label}" creada con ${rows.length} partido(s).`);
  if (rows.length < 3) console.log('AVISO: faltan partidos; el admin puede añadirlos a mano.');
}

main().catch((e) => { console.error('Error fatal:', e.message || e); process.exit(1); });
