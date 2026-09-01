-- Tests de la lógica de eliminación y de los RPC. Ejecutar como bloque en el SQL editor.
-- Crea una jornada TEST, comprueba los casos del CLAUDE.md (sección 5) y la borra al final.
-- Si algo falla, lanza excepción y no deja rastro (el bloque es transaccional).
-- Verificado en Supabase el 2026-09-01: TODOS LOS TESTS OK.
do $$
declare
  r uuid; m1 uuid; m2 uuid; m3 uuid;
  ana uuid; bea uuid; cai uuid; dan uuid; eva uuid;
  res record; n int; tok uuid;
begin
  -- Orden cronológico REAL: m3 (Ponfe, ayer) < m1 (Madrid, hace 2h) < m2 (Barça, mañana)
  insert into rounds (label) values ('TEST') returning id into r;
  insert into matches (round_id, slot, home_team, away_team, kickoff, provider) values
    (r, 1, 'Real Madrid', 'Málaga', now() - interval '2 hours', 'espn') returning id into m1;
  insert into matches (round_id, slot, home_team, away_team, kickoff, provider) values
    (r, 2, 'FC Barcelona', 'Rayo', now() + interval '1 day', 'espn') returning id into m2;
  insert into matches (round_id, slot, home_team, away_team, kickoff, provider) values
    (r, 3, 'Ourense', 'SD Ponferradina', now() - interval '1 day', 'sofascore') returning id into m3;

  insert into participants (round_id, name) values (r, 'Ana') returning id into ana;  -- acierta los 3
  insert into participants (round_id, name) values (r, 'Bea') returning id into bea;  -- falla el 1º cronológico (m3)
  insert into participants (round_id, name) values (r, 'Cai') returning id into cai;  -- falla el 3º cronológico (m2)
  insert into participants (round_id, name) values (r, 'Dan') returning id into dan;  -- sin pronóstico en m1
  insert into participants (round_id, name) values (r, 'Eva') returning id into eva;  -- falla m1 y m3: cae en m3

  insert into predictions values
    (ana, m1, 2, 0, now()), (ana, m2, 3, 1, now()), (ana, m3, 1, 1, now()),
    (bea, m1, 2, 0, now()), (bea, m2, 3, 1, now()), (bea, m3, 0, 0, now()),
    (cai, m1, 2, 0, now()), (cai, m2, 1, 1, now()), (cai, m3, 1, 1, now()),
    (dan, m2, 3, 1, now()), (dan, m3, 1, 1, now()),
    (eva, m1, 0, 0, now()), (eva, m2, 3, 1, now()), (eva, m3, 2, 2, now());

  -- C6: sin partidos finalizados, todos vivos
  select count(*) into n from evaluate_round(r) where status = 'alive';
  if n <> 5 then raise exception 'C6 fallo: esperados 5 vivos, hay %', n; end if;

  -- C5: marcador parcial de partido en juego no elimina
  update matches set home_score = 1, away_score = 0, phase = 'first_half' where id = m3;
  select count(*) into n from evaluate_round(r) where status = 'alive';
  if n <> 5 then raise exception 'C5 fallo: partido en juego eliminó gente (% vivos)', n; end if;

  -- Finaliza m3 (1-1). C2: Bea cae en el primero cronológico. Eva también cae en m3, no en m1.
  update matches set home_score = 1, away_score = 1, phase = 'finished', finished = true where id = m3;
  select * into res from evaluate_round(r) where participant_id = bea;
  if res.status <> 'eliminated' or res.eliminated_at_match_id <> m3 then raise exception 'C2 fallo (Bea)'; end if;
  select * into res from evaluate_round(r) where participant_id = eva;
  if res.status <> 'eliminated' or res.eliminated_at_match_id <> m3 then raise exception 'C3b fallo (Eva)'; end if;
  select count(*) into n from evaluate_round(r) where status = 'alive';
  if n <> 3 then raise exception 'tras m3: esperados 3 vivos, hay %', n; end if;

  -- Finaliza m1 (2-0). C4: Dan sin pronóstico en m1 queda eliminado en m1.
  update matches set home_score = 2, away_score = 0, phase = 'finished', finished = true where id = m1;
  select * into res from evaluate_round(r) where participant_id = dan;
  if res.status <> 'eliminated' or res.eliminated_at_match_id <> m1 then raise exception 'C4 fallo (Dan)'; end if;

  -- Finaliza m2 (3-1). C3: Cai cae en el último. C1: Ana sobrevive.
  update matches set home_score = 3, away_score = 1, phase = 'finished', finished = true where id = m2;
  select * into res from evaluate_round(r) where participant_id = cai;
  if res.status <> 'eliminated' or res.eliminated_at_match_id <> m2 then raise exception 'C3 fallo (Cai)'; end if;
  select * into res from evaluate_round(r) where participant_id = ana;
  if res.status <> 'alive' then raise exception 'C1 fallo (Ana)'; end if;
  select count(*) into n from evaluate_round(r) where status = 'alive';
  if n <> 1 then raise exception 'final: esperado 1 vivo, hay %', n; end if;

  -- RPC: kickoff pasado bloquea
  select edit_token into tok from participants where id = ana;
  begin
    perform upsert_prediction(ana, tok, m3, 5, 5);
    raise exception 'RPC fallo: permitió pronóstico tras kickoff';
  exception when others then
    if sqlerrm not like '%bloqueado%' then raise; end if;
  end;
  -- RPC: token inválido rechazado
  begin
    perform upsert_prediction(ana, gen_random_uuid(), m2, 5, 5);
    raise exception 'RPC fallo: aceptó token inválido';
  exception when others then
    if sqlerrm not like '%Token%' then raise; end if;
  end;
  -- RPC: kickoff futuro con token válido permite y actualiza
  perform upsert_prediction(ana, tok, m2, 4, 4);
  select home into n from predictions where participant_id = ana and match_id = m2;
  if n <> 4 then raise exception 'RPC fallo: no actualizó el pronóstico'; end if;
  -- RPC: nombre duplicado (ignora mayúsculas y espacios)
  begin
    perform register_participant(r, ' ana ');
    raise exception 'RPC fallo: aceptó nombre duplicado';
  exception when others then
    if sqlerrm not like '%ya está registrado%' then raise; end if;
  end;

  delete from rounds where id = r;
  raise notice 'TODOS LOS TESTS OK';
end $$;
