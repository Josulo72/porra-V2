-- La Porra de Supervivencia v2 — esquema inicial (aplicado en Supabase el 2026-09-01)

create extension if not exists pgcrypto;

create type round_status as enum ('open','live','closed');
create type match_phase as enum ('pre','first_half','halftime','second_half','finished');
create type provider as enum ('espn','sofascore');
create type event_type as enum ('goal','yellow','red');
create type side as enum ('home','away');
create type updater as enum ('workflow','admin');

create table rounds (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  status round_status not null default 'open',
  created_at timestamptz not null default now()
);

create table matches (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references rounds(id) on delete cascade,
  slot smallint not null check (slot between 1 and 3),
  home_team text not null,
  away_team text not null,
  home_logo text,
  away_logo text,
  kickoff timestamptz not null,
  provider provider not null,
  provider_event_id text,
  home_score smallint check (home_score >= 0),
  away_score smallint check (away_score >= 0),
  phase match_phase not null default 'pre',
  minute text,
  finished boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by updater,
  unique (round_id, slot)
);

create table match_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  minute text,
  type event_type not null,
  player text,
  side side not null,
  created_at timestamptz not null default now()
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references rounds(id) on delete cascade,
  name text not null,
  paid boolean not null default false,
  edit_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create unique index participants_name_per_round on participants (round_id, lower(trim(name)));

create table predictions (
  participant_id uuid not null references participants(id) on delete cascade,
  match_id uuid not null references matches(id) on delete cascade,
  home smallint not null check (home >= 0),
  away smallint not null check (away >= 0),
  locked_at timestamptz not null default now(),
  primary key (participant_id, match_id)
);

create table settings (
  id boolean primary key default true check (id),
  pot numeric(10,2) not null default 0,
  admin_note text
);
insert into settings (id) values (true);

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger matches_updated_at before update on matches for each row execute function set_updated_at();

-- ===== Lógica de eliminación =====
-- Orden cronológico real (kickoff), solo cuentan partidos finished = true.
create or replace function evaluate_round(p_round_id uuid)
returns table (participant_id uuid, name text, status text, eliminated_at_match_id uuid)
language sql stable as $$
  with ordered as (
    select m.id, m.kickoff, m.home_score, m.away_score,
           row_number() over (order by m.kickoff, m.slot) as ord
    from matches m
    where m.round_id = p_round_id and m.finished = true
      and m.home_score is not null and m.away_score is not null
  ),
  fails as (
    select p.id as participant_id, o.id as match_id, o.ord
    from participants p
    cross join ordered o
    left join predictions pr on pr.participant_id = p.id and pr.match_id = o.id
    where p.round_id = p_round_id
      and (pr.participant_id is null or pr.home <> o.home_score or pr.away <> o.away_score)
  ),
  first_fail as (
    select distinct on (participant_id) participant_id, match_id
    from fails order by participant_id, ord
  )
  select p.id, p.name,
         case when ff.participant_id is null then 'alive' else 'eliminated' end,
         ff.match_id
  from participants p
  left join first_fail ff on ff.participant_id = p.id
  where p.round_id = p_round_id
  order by (ff.participant_id is not null), lower(p.name);
$$;

-- ===== RPCs para participantes (sin escritura directa en tablas) =====
create or replace function register_participant(p_round_id uuid, p_name text)
returns table (participant_id uuid, edit_token uuid)
language plpgsql security definer set search_path = public as $$
declare v_name text := trim(p_name); v_id uuid; v_token uuid;
begin
  if v_name is null or length(v_name) < 2 or length(v_name) > 40 then
    raise exception 'Nombre inválido';
  end if;
  if not exists (select 1 from rounds where id = p_round_id and status <> 'closed') then
    raise exception 'La jornada está cerrada';
  end if;
  insert into participants (round_id, name) values (p_round_id, v_name)
  returning id, participants.edit_token into v_id, v_token;
  return query select v_id, v_token;
exception when unique_violation then
  raise exception 'Ese nombre ya está registrado en esta jornada';
end $$;

create or replace function upsert_prediction(p_participant_id uuid, p_token uuid, p_match_id uuid, p_home int, p_away int)
returns void
language plpgsql security definer set search_path = public as $$
declare v_kickoff timestamptz;
begin
  if not exists (select 1 from participants where id = p_participant_id and edit_token = p_token) then
    raise exception 'Token inválido';
  end if;
  select kickoff into v_kickoff from matches m
    join participants p on p.round_id = m.round_id
    where m.id = p_match_id and p.id = p_participant_id;
  if v_kickoff is null then raise exception 'Partido no encontrado'; end if;
  if now() >= v_kickoff then raise exception 'El partido ya ha empezado: pronóstico bloqueado'; end if;
  if p_home < 0 or p_away < 0 or p_home > 20 or p_away > 20 then raise exception 'Marcador inválido'; end if;
  insert into predictions (participant_id, match_id, home, away)
  values (p_participant_id, p_match_id, p_home, p_away)
  on conflict (participant_id, match_id) do update set home = excluded.home, away = excluded.away, locked_at = now();
end $$;

-- ===== RLS =====
alter table rounds enable row level security;
alter table matches enable row level security;
alter table match_events enable row level security;
alter table participants enable row level security;
alter table predictions enable row level security;
alter table settings enable row level security;

create policy "lectura publica" on rounds for select using (true);
create policy "lectura publica" on matches for select using (true);
create policy "lectura publica" on match_events for select using (true);
create policy "lectura publica" on participants for select using (true);
create policy "lectura publica" on predictions for select using (true);
create policy "lectura publica" on settings for select using (true);

create policy "admin todo" on rounds for all to authenticated using (true) with check (true);
create policy "admin todo" on matches for all to authenticated using (true) with check (true);
create policy "admin todo" on match_events for all to authenticated using (true) with check (true);
create policy "admin todo" on participants for all to authenticated using (true) with check (true);
create policy "admin todo" on predictions for all to authenticated using (true) with check (true);
create policy "admin todo" on settings for all to authenticated using (true) with check (true);

revoke insert, update, delete on all tables in schema public from anon;
revoke select on participants from anon, authenticated;
grant select (id, round_id, name, paid, created_at) on participants to anon, authenticated;

grant execute on function register_participant(uuid, text) to anon, authenticated;
grant execute on function upsert_prediction(uuid, uuid, uuid, int, int) to anon, authenticated;
grant execute on function evaluate_round(uuid) to anon, authenticated;
