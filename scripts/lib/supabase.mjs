// Cliente mínimo de Supabase REST para GitHub Actions (sin dependencias npm).
// Usa la service role key: solo se ejecuta en el runner, nunca en el navegador.

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function req(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const db = {
  select: (table, query) => req('GET', `${table}?${query}`),
  insert: (table, rows) => req('POST', table, rows),
  update: (table, query, patch) => req('PATCH', `${table}?${query}`, patch),
  remove: (table, query) => req('DELETE', `${table}?${query}`),
};
