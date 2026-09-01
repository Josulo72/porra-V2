// Utilidades de fecha en hora de Madrid. Los kickoff se guardan en UTC (timestamptz).

const MADRID = 'Europe/Madrid';

export function madridWeekday(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: MADRID, weekday: 'short' }).format(date);
}

export function madridDateLabel(date) {
  return new Intl.DateTimeFormat('es-ES', { timeZone: MADRID, day: 'numeric', month: 'short' }).format(date);
}

// Sábado, domingo o lunes en hora de Madrid. Viernes y entre semana quedan fuera.
export function isWeekendMatch(date) {
  return ['Sat', 'Sun', 'Mon'].includes(madridWeekday(date));
}

export function minutesSince(date) {
  return (Date.now() - date.getTime()) / 60000;
}
