-- The Lost Starlight Crown in the 3D Journey: one hidden chest for the whole world (4 map pieces, then the Crown Guardian).
-- The first child who reaches it wins it; everyone else sees who found it first.
create table if not exists public.journey_treasure (
  id          int primary key default 1 check (id = 1),
  season      int not null default 1,
  child_id    text references public.children(id) on delete set null,
  family_id   uuid references public.families(id) on delete set null,
  winner_name text check (winner_name is null or char_length(winner_name) between 1 and 40),
  found_at    timestamptz
);
insert into public.journey_treasure (id) values (1) on conflict (id) do nothing;
alter table public.journey_treasure enable row level security;
-- no table policies: reads and the claim go through the two functions below

-- Anyone can ask whether the treasure has been found and by whom (a first name, or "A young explorer").
-- "mine" is true only for the winning child's own family.
create or replace function public.treasure_status(p_child text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'found', t.found_at is not null,
    'name', t.winner_name,
    'at', t.found_at,
    'season', t.season,
    'mine', coalesce(t.found_at is not null and p_child is not null and t.child_id = p_child
                     and auth.uid() is not null and public.is_member(t.family_id), false))
  from public.journey_treasure t where t.id = 1;
$$;

-- Claim it. Only a member of the child's family can claim, and the child's saved journey must have
-- reached the last island. The update only succeeds while nobody has found it yet, so exactly one child wins.
create or replace function public.treasure_claim(p_child text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  fid uuid;
  zone int;
  pieces int;
  nm text;
  r public.journey_treasure%rowtype;
begin
  if auth.uid() is null then raise exception 'Please log in.'; end if;
  select family_id into fid from public.children where id = p_child;
  if fid is null or not public.is_member(fid) then raise exception 'This child is not on your account.'; end if;
  begin
    select coalesce(((p.data->>'journey')::jsonb->>'maxZone')::int, 0) into zone
    from public.progress p where p.child_id = p_child;
  exception when others then zone := 0;
  end;
  if coalesce(zone, 0) < 7 then raise exception 'Reach the last island first.'; end if;
  -- all 4 map pieces must be in the saved journey too
  begin
    select count(distinct x.value) into pieces
    from public.progress p, jsonb_array_elements_text(((p.data->>'journey')::jsonb)->'mapP') x
    where p.child_id = p_child;
  exception when others then pieces := 0;
  end;
  if coalesce(pieces, 0) < 4 then raise exception 'Collect all 4 map pieces first.'; end if;
  nm := btrim(coalesce(p_name, ''));
  if nm !~ '^[[:alpha:][:space:].''-]{1,40}$' then nm := 'A young explorer'; end if;

  update public.journey_treasure
     set child_id = p_child, family_id = fid, winner_name = nm, found_at = now()
   where id = 1 and found_at is null
  returning * into r;
  if found then
    return jsonb_build_object('won', true, 'name', r.winner_name, 'at', r.found_at);
  end if;
  select * into r from public.journey_treasure where id = 1;
  return jsonb_build_object('won', r.child_id = p_child, 'name', r.winner_name, 'at', r.found_at);
end $$;

revoke all on function public.treasure_status(text) from public;
revoke all on function public.treasure_claim(text, text) from public;
grant execute on function public.treasure_status(text) to anon, authenticated;
grant execute on function public.treasure_claim(text, text) to authenticated;
