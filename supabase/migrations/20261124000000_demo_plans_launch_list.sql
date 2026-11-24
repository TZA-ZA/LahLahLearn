-- Demo phase: any plan can be chosen without payment, and visitors can leave an email to hear about the launch.
create or replace function public.demo_set_plan(p_family uuid, p_plan text, p_children int default 1, p_features jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f public.families%rowtype;
begin
  if auth.uid() is null then raise exception 'Please log in.'; end if;
  select * into f from public.families where id = p_family;
  if not found then raise exception 'Family not found.'; end if;
  if f.owner_id is distinct from auth.uid() then raise exception 'Only the account owner can change the plan.'; end if;
  if p_plan not in ('free','learn','family') then raise exception 'Unknown plan.'; end if;
  update public.families
     set plan = p_plan,
         plan_status = case when p_plan = 'free' then 'none' else 'active' end,
         paid_children = greatest(1, least(3, coalesce(p_children, 1))),
         features = case when p_plan = 'learn' then coalesce(p_features, '{}'::jsonb) else '{}'::jsonb end,
         trial_ends_at = null,
         cancel_at_period_end = false,
         updated_at = now()
   where id = p_family;
  return jsonb_build_object('ok', true, 'plan', p_plan);
end $$;
revoke all on function public.demo_set_plan(uuid, text, int, jsonb) from public;
grant execute on function public.demo_set_plan(uuid, text, int, jsonb) to authenticated;

create table if not exists public.launch_signups (
  email      text primary key check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 160),
  name       text check (name is null or char_length(name) <= 60),
  source     text check (source is null or char_length(source) <= 40),
  created_at timestamptz not null default now(),
  notified_at timestamptz
);
alter table public.launch_signups enable row level security;
-- no table policies: sign-ups go through the function below, and only the team reads the list

create or replace function public.launch_signup(p_email text, p_name text default null, p_source text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e text := lower(btrim(coalesce(p_email, '')));
begin
  if e !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(e) > 160 then raise exception 'Please check the email address.'; end if;
  insert into public.launch_signups(email, name, source)
  values (e, nullif(left(btrim(coalesce(p_name, '')), 60), ''), left(coalesce(p_source, 'app'), 40))
  on conflict (email) do nothing;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.launch_signup(text, text, text) from public;
grant execute on function public.launch_signup(text, text, text) to anon, authenticated;
