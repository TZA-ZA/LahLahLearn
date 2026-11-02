-- LahLahLearn database
-- One family account (parent) holds up to 3 children. Teachers and therapists join a family's
-- Care Circle by invite and can see that family's children, add shared notes and (therapists)
-- offer check-up times. Billing state is written only by the Stripe webhook (service role).
--
-- Security model: every table has row level security. Clients use the anon key + the user's
-- session; anything sensitive (billing, invites email, AI usage, admin numbers) goes through
-- edge functions running with the service role.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.families (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null unique references auth.users(id) on delete cascade,
  name                   text,
  -- billing (service role only)
  plan                   text not null default 'free' check (plan in ('free','family','school')),
  plan_status            text not null default 'none'
                         check (plan_status in ('none','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')),
  trial_started_at       timestamptz,
  trial_ends_at          timestamptz,
  billing_cycle          text check (billing_cycle in ('month','year')),
  paid_children          smallint not null default 1 check (paid_children between 1 and 3),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  -- weekly report settings (parents)
  report_email           text check (report_email is null or report_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  report_auto            boolean not null default false,
  report_day             smallint not null default 6 check (report_day between 0 and 6), -- 0 = Monday
  report_last_sent       date,
  -- app state (parents)
  active_child_id        text,
  kids_meta              jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table public.family_members (
  family_id     uuid not null references public.families(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('parent','teacher','therapist')),
  display_name  text not null default '' check (char_length(display_name) <= 80),
  email         text,
  availability  text[] not null default '{}',   -- 'Mon 09:00' style slots, therapists
  created_at    timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index family_members_user_idx on public.family_members(user_id);

create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  email        text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name         text not null default '' check (char_length(name) <= 80),
  role         text not null check (role in ('parent','teacher','therapist')),
  token        uuid not null unique default gen_random_uuid(),
  invited_by   uuid references auth.users(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null
);
create index invites_family_idx on public.invites(family_id);

create table public.children (
  id            text primary key check (id ~ '^[A-Za-z0-9_-]{3,40}$'),
  family_id     uuid not null references public.families(id) on delete cascade,
  display_name  text not null default '' check (char_length(display_name) <= 120),
  profile       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index children_family_idx on public.children(family_id);

create table public.progress (
  child_id    text primary key references public.children(id) on delete cascade,
  family_id   uuid not null references public.families(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
create index progress_family_idx on public.progress(family_id);

-- one row per child per day, filled from progress.data->'mins' (seconds per day) by a trigger
create table public.daily_activity (
  child_id   text not null references public.children(id) on delete cascade,
  family_id  uuid not null references public.families(id) on delete cascade,
  day        date not null,
  seconds    integer not null default 0 check (seconds >= 0),
  primary key (child_id, day)
);
create index daily_activity_day_idx on public.daily_activity(day);

create table public.shared_notes (
  child_id    text primary key references public.children(id) on delete cascade,
  family_id   uuid not null references public.families(id) on delete cascade,
  body        text not null default '' check (char_length(body) <= 8000),
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table public.appointments (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  child_id           text not null references public.children(id) on delete cascade,
  starts_at          timestamptz not null,
  therapist_user_id  uuid references auth.users(id) on delete set null,
  therapist_name     text not null check (char_length(therapist_name) between 1 and 120),
  mode               text not null default 'online' check (mode in ('online','person')),
  note               text not null default '' check (char_length(note) <= 1000),
  booked_by          uuid references auth.users(id) on delete set null default auth.uid(),
  booked_by_name     text not null default '',
  status             text not null default 'booked' check (status in ('booked','canceled')),
  created_at         timestamptz not null default now()
);
create index appointments_family_idx on public.appointments(family_id, starts_at);
create unique index appointments_no_double_booking
  on public.appointments(therapist_user_id, starts_at) where status = 'booked' and therapist_user_id is not null;

create table public.leaderboard (
  id          text primary key check (char_length(id) <= 120),
  family_id   uuid not null references public.families(id) on delete cascade,
  child_id    text references public.children(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  streak      integer not null default 0,
  best        integer not null default 0,
  last        text not null default '',
  pts         integer not null default 0,
  mpts        integer not null default 0,
  gmpts       integer not null default 0,
  mkey        text not null default '',
  ts          bigint not null default 0,
  updated_at  timestamptz not null default now()
);

-- service-role only tables
create table public.ai_usage (
  family_id  uuid not null references public.families(id) on delete cascade,
  day        date not null default current_date,
  requests   integer not null default 0,
  primary key (family_id, day)
);
create table public.stripe_events (
  id           text primary key,
  type         text not null,
  received_at  timestamptz not null default now()
);
create table public.email_log (
  id          bigserial primary key,
  family_id   uuid references public.families(id) on delete set null,
  kind        text not null,
  to_email    text not null,
  status      text not null,
  detail      text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers

create or replace function public.member_role(fid uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.family_members where family_id = fid and user_id = auth.uid()
$$;
create or replace function public.is_member(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.family_members where family_id = fid and user_id = auth.uid())
$$;
create or replace function public.is_parent(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.family_members where family_id = fid and user_id = auth.uid() and role = 'parent')
$$;
create or replace function public.child_family(cid text) returns uuid
language sql stable security definer set search_path = public as $$
  select family_id from public.children where id = cid
$$;

-- What the app is allowed to use right now: 'family' during a trial or a paid subscription.
create or replace function public.effective_plan(f public.families) returns text
language sql stable as $$
  select case
    when f.plan = 'school' and f.plan_status in ('active','trialing','past_due') then 'school'
    when f.plan = 'family' and f.plan_status in ('active','trialing','past_due') then 'family'
    when f.trial_ends_at is not null and f.trial_ends_at > now() then 'family'
    else 'free' end
$$;

-- ---------------------------------------------------------------- triggers

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger families_touch before update on public.families for each row execute function public.touch_updated_at();
create trigger children_touch before update on public.children for each row execute function public.touch_updated_at();
create trigger progress_touch before update on public.progress for each row execute function public.touch_updated_at();
create trigger leaderboard_touch before update on public.leaderboard for each row execute function public.touch_updated_at();

-- new sign-up -> profile row
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- children: at most 3 per family; keep display_name in step with the profile
create or replace function public.children_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and (select count(*) from public.children where family_id = new.family_id) >= 3 then
    raise exception 'A family account can have up to 3 children' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.family_id <> old.family_id then
    raise exception 'A child cannot move to another family';
  end if;
  new.display_name := left(coalesce(nullif(new.profile->>'name',''), new.display_name, ''), 120);
  return new;
end $$;
create trigger children_guard before insert or update on public.children
  for each row execute function public.children_guard();

-- child-scoped rows always take their family from the child (clients cannot spoof family_id).
-- Trigger names start with a_ so they run before the other BEFORE triggers (Postgres fires them alphabetically).
create or replace function public.set_family_from_child() returns trigger
language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  select family_id into fid from public.children where id = new.child_id;
  if fid is null then raise exception 'Unknown child'; end if;
  new.family_id := fid;
  return new;
end $$;
create trigger a_progress_family before insert or update on public.progress for each row execute function public.set_family_from_child();
create trigger a_notes_family before insert or update on public.shared_notes for each row execute function public.set_family_from_child();
create trigger a_appts_family before insert or update on public.appointments for each row execute function public.set_family_from_child();

-- progress.data.mins is {"YYYY-MM-DD": seconds}; mirror the last 60 days into daily_activity
create or replace function public.sync_daily_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if jsonb_typeof(new.data->'mins') = 'object' then
    insert into public.daily_activity(child_id, family_id, day, seconds)
    select new.child_id, new.family_id, k::date, greatest(0, least(86400, floor((v #>> '{}')::numeric)))::int
    from jsonb_each(new.data->'mins') as e(k, v)
    where k ~ '^\d{4}-\d{2}-\d{2}$' and jsonb_typeof(v) = 'number' and k::date >= current_date - 60
    on conflict (child_id, day) do update set seconds = excluded.seconds;
  end if;
  return new;
end $$;
create trigger progress_activity after insert or update of data on public.progress
  for each row execute function public.sync_daily_activity();

-- appointments: who booked is the caller; only therapists of this family can be booked
create or replace function public.appointments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.booked_by := coalesce(auth.uid(), new.booked_by);
    new.status := 'booked';
    if new.therapist_user_id is not null and not exists (
      select 1 from public.family_members where family_id = new.family_id and user_id = new.therapist_user_id and role = 'therapist') then
      raise exception 'That therapist is not in this Care Circle';
    end if;
    if new.starts_at < now() - interval '5 minutes' then
      raise exception 'Please pick a time in the future';
    end if;
  elsif tg_op = 'UPDATE' then
    -- only the status can change after booking
    if (new.starts_at, new.therapist_user_id, new.child_id, new.booked_by) is distinct from
       (old.starts_at, old.therapist_user_id, old.child_id, old.booked_by) then
      raise exception 'Only cancelling is allowed; book a new time instead';
    end if;
  end if;
  return new;
end $$;
create trigger appointments_guard before insert or update on public.appointments
  for each row execute function public.appointments_guard();

-- family members can change only their own display name and availability
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id <> auth.uid() then raise exception 'You can only change your own details'; end if;
  if (new.role, new.family_id, new.user_id) is distinct from (old.role, old.family_id, old.user_id) then
    raise exception 'Role changes are not allowed';
  end if;
  return new;
end $$;
create trigger members_guard before update on public.family_members
  for each row when (auth.uid() is not null) execute function public.members_guard();

-- ---------------------------------------------------------------- RPCs used by the app

-- Everything the app needs right after login.
create or replace function public.my_context() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'email', (select email from public.profiles where id = auth.uid()),
    'is_admin', coalesce((select is_admin from public.profiles where id = auth.uid()), false),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'family_id', f.id, 'role', m.role, 'owner', f.owner_id = auth.uid(),
        'family_name', f.name, 'plan', public.effective_plan(f), 'plan_status', f.plan_status,
        'trial_started_at', f.trial_started_at, 'trial_ends_at', f.trial_ends_at,
        'billing_cycle', f.billing_cycle, 'paid_children', f.paid_children,
        'current_period_end', f.current_period_end, 'cancel_at_period_end', f.cancel_at_period_end,
        'has_subscription', f.stripe_subscription_id is not null,
        'children', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.display_name) order by c.created_at)
                              from public.children c where c.family_id = f.id), '[]'::jsonb))
        order by (m.role = 'parent') desc, m.created_at)
      from public.family_members m join public.families f on f.id = m.family_id
      where m.user_id = auth.uid()), '[]'::jsonb)
  )
$$;

-- Creates the caller's own family (parent account) if it does not exist yet.
create or replace function public.ensure_family(p_name text default null, p_display_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid; uemail text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into fid from public.families where owner_id = auth.uid();
  if fid is not null then return fid; end if;
  select email into uemail from public.profiles where id = auth.uid();
  insert into public.families(owner_id, name, report_email)
    values (auth.uid(), left(nullif(trim(p_name),''), 120), uemail)
    returning id into fid;
  insert into public.family_members(family_id, user_id, role, display_name, email)
    values (fid, auth.uid(), 'parent', left(coalesce(nullif(trim(p_display_name),''), ''), 80), uemail);
  return fid;
end $$;

-- 7-day Family trial, once per family, no card needed.
create or replace function public.start_trial(p_family uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f public.families;
begin
  if not public.is_parent(p_family) then raise exception 'Only a parent can start the trial'; end if;
  select * into f from public.families where id = p_family for update;
  if f.plan_status in ('active','trialing','past_due') then
    return jsonb_build_object('ok', false, 'reason', 'subscribed');
  end if;
  if f.trial_started_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'trial_used', 'trial_ends_at', f.trial_ends_at);
  end if;
  update public.families set trial_started_at = now(), trial_ends_at = now() + interval '7 days'
    where id = p_family returning * into f;
  return jsonb_build_object('ok', true, 'trial_ends_at', f.trial_ends_at);
end $$;

-- Accept a Care Circle invite (the signed-in email must match the invited email).
create or replace function public.accept_invite(p_token uuid, p_display_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invites; uemail text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into inv from public.invites where token = p_token for update;
  if inv.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if inv.accepted_at is not null then
    return jsonb_build_object('ok', inv.accepted_by = auth.uid(), 'reason', 'already_used', 'family_id', inv.family_id);
  end if;
  if inv.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select email into uemail from public.profiles where id = auth.uid();
  if lower(coalesce(uemail,'')) <> lower(inv.email) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_email', 'invited_email', inv.email);
  end if;
  insert into public.family_members(family_id, user_id, role, display_name, email)
    values (inv.family_id, auth.uid(), inv.role, left(coalesce(nullif(trim(p_display_name),''), inv.name, ''), 80), uemail)
    on conflict (family_id, user_id) do nothing;
  update public.invites set accepted_at = now(), accepted_by = auth.uid() where id = inv.id;
  return jsonb_build_object('ok', true, 'family_id', inv.family_id, 'role', inv.role);
end $$;

-- Remove someone from the Care Circle (parents only; the owner cannot be removed).
create or replace function public.remove_member(p_family uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_parent(p_family) then raise exception 'Only a parent can remove people'; end if;
  if p_user = (select owner_id from public.families where id = p_family) then
    raise exception 'The account owner cannot be removed';
  end if;
  delete from public.family_members where family_id = p_family and user_id = p_user;
end $$;

-- ---------------------------------------------------------------- privileges

revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;

revoke all on public.ai_usage, public.stripe_events, public.email_log from authenticated;

revoke insert, update, delete on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

revoke insert, update, delete on public.families from authenticated;
grant update (name, report_email, report_auto, report_day, active_child_id, kids_meta) on public.families to authenticated;

revoke insert, update on public.family_members from authenticated;
grant update (display_name, availability) on public.family_members to authenticated;

revoke update on public.invites from authenticated;

revoke update on public.appointments from authenticated;
grant update (status) on public.appointments to authenticated;


-- ---------------------------------------------------------------- row level security

alter table public.profiles        enable row level security;
alter table public.families        enable row level security;
alter table public.family_members  enable row level security;
alter table public.invites         enable row level security;
alter table public.children        enable row level security;
alter table public.progress        enable row level security;
alter table public.daily_activity  enable row level security;
alter table public.shared_notes    enable row level security;
alter table public.appointments    enable row level security;
alter table public.leaderboard     enable row level security;
alter table public.ai_usage        enable row level security;
alter table public.stripe_events   enable row level security;
alter table public.email_log       enable row level security;

create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "members see family" on public.families for select to authenticated using (public.is_member(id));
create policy "parents edit family" on public.families for update to authenticated using (public.is_parent(id)) with check (public.is_parent(id));

create policy "members see circle" on public.family_members for select to authenticated using (public.is_member(family_id));
create policy "edit own membership" on public.family_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "leave a circle" on public.family_members for delete to authenticated
  using (user_id = auth.uid() and role <> 'parent');

create policy "parents see invites" on public.invites for select to authenticated using (public.is_parent(family_id));
create policy "parents invite" on public.invites for insert to authenticated
  with check (public.is_parent(family_id) and invited_by = auth.uid() and accepted_at is null);
create policy "parents cancel invites" on public.invites for delete to authenticated using (public.is_parent(family_id));

create policy "members see children" on public.children for select to authenticated using (public.is_member(family_id));
create policy "parents add children" on public.children for insert to authenticated with check (public.is_parent(family_id));
create policy "parents edit children" on public.children for update to authenticated using (public.is_parent(family_id)) with check (public.is_parent(family_id));
create policy "parents remove children" on public.children for delete to authenticated using (public.is_parent(family_id));

create policy "members see progress" on public.progress for select to authenticated using (public.is_member(family_id));
create policy "parents save progress" on public.progress for insert to authenticated with check (public.is_parent(public.child_family(child_id)));
create policy "parents update progress" on public.progress for update to authenticated
  using (public.is_parent(family_id)) with check (public.is_parent(public.child_family(child_id)));
create policy "parents delete progress" on public.progress for delete to authenticated using (public.is_parent(family_id));

create policy "members see activity" on public.daily_activity for select to authenticated using (public.is_member(family_id));

create policy "members see notes" on public.shared_notes for select to authenticated using (public.is_member(family_id));
create policy "members write notes" on public.shared_notes for insert to authenticated
  with check (public.is_member(public.child_family(child_id)) and updated_by = auth.uid());
create policy "members update notes" on public.shared_notes for update to authenticated
  using (public.is_member(family_id)) with check (public.is_member(public.child_family(child_id)) and updated_by = auth.uid());

create policy "members see check-ups" on public.appointments for select to authenticated using (public.is_member(family_id));
create policy "parents and therapists book" on public.appointments for insert to authenticated
  with check (public.member_role(public.child_family(child_id)) in ('parent','therapist'));
create policy "parents and the therapist cancel" on public.appointments for update to authenticated
  using (public.is_parent(family_id) or therapist_user_id = auth.uid() or booked_by = auth.uid())
  with check (status in ('booked','canceled'));

create policy "hall of fame is visible to signed-in users" on public.leaderboard for select to authenticated using (true);
create policy "parents publish" on public.leaderboard for insert to authenticated with check (public.is_parent(family_id));
create policy "parents update entry" on public.leaderboard for update to authenticated using (public.is_parent(family_id)) with check (public.is_parent(family_id));
create policy "parents remove entry" on public.leaderboard for delete to authenticated using (public.is_parent(family_id));

-- functions callable by signed-in users
grant execute on function public.my_context() to authenticated;
grant execute on function public.ensure_family(text, text) to authenticated;
grant execute on function public.start_trial(uuid) to authenticated;
grant execute on function public.accept_invite(uuid, text) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.is_member(uuid), public.is_parent(uuid), public.member_role(uuid), public.child_family(text) to authenticated;
grant execute on function public.effective_plan(public.families) to authenticated;
