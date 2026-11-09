-- Pip AI credits: a monthly allowance per family plus bought credits that never expire.
create table if not exists public.ai_credits(
  family_id uuid primary key references public.families(id) on delete cascade,
  month text not null default to_char(now(),'YYYY-MM'),
  used integer not null default 0,
  bonus integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.ai_credits enable row level security;
drop policy if exists ai_credits_read on public.ai_credits;
create policy ai_credits_read on public.ai_credits for select to authenticated
  using (exists(select 1 from public.family_members m where m.family_id=ai_credits.family_id and m.user_id=(select auth.uid())));

-- Spend credits atomically: the monthly allowance first, then bought credits. Returns {ok,left,allow,bonus}.
create or replace function public.ai_spend(p_family uuid,p_month text,p_allow int,p_cost int)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.ai_credits; mleft int; take_m int; take_b int;
begin
  insert into public.ai_credits(family_id,month) values(p_family,p_month) on conflict(family_id) do nothing;
  select * into r from public.ai_credits where family_id=p_family for update;
  if r.month<>p_month then r.used:=0; r.month:=p_month; end if;
  mleft:=greatest(0,p_allow-r.used);
  if p_cost>0 and mleft+r.bonus<p_cost then
    update public.ai_credits set month=r.month,used=r.used,updated_at=now() where family_id=p_family;
    return jsonb_build_object('ok',false,'left',mleft+r.bonus,'allow',p_allow,'bonus',r.bonus);
  end if;
  take_m:=least(mleft,greatest(p_cost,0)); take_b:=greatest(p_cost,0)-take_m;
  update public.ai_credits set month=r.month,used=r.used+take_m,bonus=r.bonus-take_b,updated_at=now() where family_id=p_family;
  return jsonb_build_object('ok',true,'left',mleft-take_m+r.bonus-take_b,'allow',p_allow,'bonus',r.bonus-take_b);
end $$;

create or replace function public.ai_add_bonus(p_family uuid,p_n int)
returns void language sql security definer set search_path=public as $$
  insert into public.ai_credits(family_id,bonus) values(p_family,greatest(p_n,0))
  on conflict(family_id) do update set bonus=public.ai_credits.bonus+greatest(p_n,0),updated_at=now();
$$;
revoke all on function public.ai_spend(uuid,text,int,int) from public,anon,authenticated;
revoke all on function public.ai_add_bonus(uuid,int) from public,anon,authenticated;
grant execute on function public.ai_spend(uuid,text,int,int) to service_role;
grant execute on function public.ai_add_bonus(uuid,int) to service_role;
