// Proveedores de datos. ESPN para Real Madrid y FC Barcelona (La Liga),
// Sofascore para SD Ponferradina (Primera Federación).
// Cada proveedor devuelve el mismo objeto normalizado:
//   { providerEventId, kickoff: Date, homeTeam, awayTeam, homeLogo, awayLogo }   (próximo partido)
//   { homeScore, awayScore, phase, minute, finished, events: [{minute,type,player,side}] } (estado en vivo)

const TIMEOUT = 10000;

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// ===================== ESPN =====================
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

function espnLogo(competitor) {
  const href = competitor.team?.logos?.[0]?.href || competitor.team?.logo;
  if (href) return href;
  const id = competitor.team?.id;
  return id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${id}.png` : null;
}

export const espn = {
  // Próximos partidos del equipo en La Liga (esp.1). Copa y otras competiciones de
  // fin de semana no aparecen aquí: el admin las mete a mano.
  async upcoming(teamId) {
    const base = `${ESPN_BASE}/esp.1/teams/${teamId}/schedule`;
    let events = [];
    for (const url of [`${base}?fixture=true`, base]) {
      try {
        const data = await getJson(url);
        events = events.concat(data.events || []);
      } catch (e) {
        console.log(`  ESPN schedule: ${e.message}`);
      }
    }
    const seen = new Set();
    return events
      .filter((ev) => ev.id && !seen.has(ev.id) && seen.add(ev.id))
      .map((ev) => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find((c) => c.homeAway === 'home');
        const away = comp?.competitors?.find((c) => c.homeAway === 'away');
        if (!home || !away) return null;
        return {
          providerEventId: String(ev.id),
          kickoff: new Date(ev.date),
          homeTeam: home.team.displayName || home.team.name,
          awayTeam: away.team.displayName || away.team.name,
          homeLogo: espnLogo(home),
          awayLogo: espnLogo(away),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.kickoff - b.kickoff);
  },

  async live(eventId) {
    const data = await getJson(`${ESPN_BASE}/esp.1/summary?event=${eventId}`);
    const comp = data.header?.competitions?.[0];
    if (!comp) throw new Error('ESPN: respuesta sin competición');
    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    const st = comp.status || {};
    const state = st.type?.state; // pre | in | post
    const period = Number(st.period || 0);
    const desc = (st.type?.description || '').toLowerCase();
    let phase = 'pre';
    if (state === 'post') phase = 'finished';
    else if (state === 'in') phase = desc.includes('half') && desc.includes('halftime') ? 'halftime' : period >= 2 ? 'second_half' : 'first_half';
    if (state === 'in' && (desc === 'halftime' || desc.includes('descanso'))) phase = 'halftime';
    const homeId = String(home.team?.id || home.id);
    const events = (data.keyEvents || comp.details || [])
      .map((d) => {
        const t = (d.type?.text || '').toLowerCase();
        let type = null;
        if (d.scoringPlay || t.includes('goal')) type = 'goal';
        else if (t.includes('yellow')) type = 'yellow';
        else if (t.includes('red')) type = 'red';
        if (!type) return null;
        return {
          minute: (d.clock?.displayValue || '').replace(/'/g, ''),
          type,
          player: d.participants?.[0]?.athlete?.displayName || d.athletesInvolved?.[0]?.displayName || null,
          side: String(d.team?.id || '') === homeId ? 'home' : 'away',
        };
      })
      .filter(Boolean);
    const h = parseInt(home.score, 10), a = parseInt(away.score, 10);
    return {
      homeScore: Number.isNaN(h) ? null : h,
      awayScore: Number.isNaN(a) ? null : a,
      phase,
      minute: state === 'in' ? (st.displayClock || '').replace(/'/g, '') : null,
      finished: state === 'post' && st.type?.completed !== false,
      events,
    };
  },
};

// ===================== Sofascore =====================
const SOFA_BASE = 'https://api.sofascore.com/api/v1';
const SOFA_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9',
  Referer: 'https://www.sofascore.com/',
  Origin: 'https://www.sofascore.com',
};
const sofaLogo = (team) => (team?.id ? `${SOFA_BASE}/team/${team.id}/image` : null);

export const sofascore = {
  async upcoming(teamId) {
    const data = await getJson(`${SOFA_BASE}/team/${teamId}/events/next/0`, SOFA_HEADERS);
    return (data.events || [])
      .map((ev) => ({
        providerEventId: String(ev.id),
        kickoff: new Date(ev.startTimestamp * 1000),
        homeTeam: ev.homeTeam?.name,
        awayTeam: ev.awayTeam?.name,
        homeLogo: sofaLogo(ev.homeTeam),
        awayLogo: sofaLogo(ev.awayTeam),
      }))
      .filter((m) => m.homeTeam && m.awayTeam)
      .sort((a, b) => a.kickoff - b.kickoff);
  },

  async live(eventId) {
    const { event } = await getJson(`${SOFA_BASE}/event/${eventId}`, SOFA_HEADERS);
    if (!event) throw new Error('Sofascore: respuesta sin evento');
    const code = Number(event.status?.code || 0);
    const type = event.status?.type; // notstarted | inprogress | finished
    // Códigos Sofascore: 6 primera parte, 31 descanso, 7 segunda parte, 100 finalizado
    let phase = 'pre';
    if (type === 'finished') phase = 'finished';
    else if (code === 31) phase = 'halftime';
    else if (code === 7) phase = 'second_half';
    else if (type === 'inprogress') phase = 'first_half';
    let minute = null;
    if (type === 'inprogress' && event.time?.currentPeriodStartTimestamp && phase !== 'halftime') {
      let m = Math.floor((Date.now() / 1000 - event.time.currentPeriodStartTimestamp) / 60) + 1;
      if (phase === 'second_half') m += 45;
      minute = String(Math.max(1, Math.min(m, 120)));
    }
    let events = [];
    try {
      const inc = await getJson(`${SOFA_BASE}/event/${eventId}/incidents`, SOFA_HEADERS);
      events = (inc.incidents || [])
        .map((i) => {
          if (i.incidentType === 'goal') {
            return { minute: String(i.time ?? ''), type: 'goal', player: i.player?.shortName || i.player?.name || null, side: i.isHome ? 'home' : 'away' };
          }
          if (i.incidentType === 'card') {
            const cls = (i.incidentClass || '').toLowerCase();
            return { minute: String(i.time ?? ''), type: cls.includes('red') || cls === 'yellowred' ? 'red' : 'yellow', player: i.player?.shortName || i.player?.name || null, side: i.isHome ? 'home' : 'away' };
          }
          return null;
        })
        .filter(Boolean)
        .reverse();
    } catch (e) {
      console.log(`  Sofascore incidents: ${e.message}`);
    }
    const h = event.homeScore?.current, a = event.awayScore?.current;
    return {
      homeScore: h == null ? null : Number(h),
      awayScore: a == null ? null : Number(a),
      phase,
      minute,
      finished: type === 'finished',
      events,
    };
  },
};

export const providers = { espn, sofascore };
