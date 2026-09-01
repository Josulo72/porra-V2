-- Endurecimiento tras el linter de seguridad de Supabase (aplicado el 2026-09-01)
alter function set_updated_at() set search_path = public;
alter function evaluate_round(uuid) set search_path = public;

-- Tope de participantes por jornada para evitar spam de altas anónimas
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
  if (select count(*) from participants where round_id = p_round_id) >= 300 then
    raise exception 'Jornada llena';
  end if;
  insert into participants (round_id, name) values (p_round_id, v_name)
  returning id, participants.edit_token into v_id, v_token;
  return query select v_id, v_token;
exception when unique_violation then
  raise exception 'Ese nombre ya está registrado en esta jornada';
end $$;
