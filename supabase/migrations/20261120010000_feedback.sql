-- Messages from the feedback form. Only the team (service role / admins) can read them.
create table if not exists public.feedback (
  id bigserial primary key,
  kind text not null check (kind in ('idea','problem','praise','other')),
  name text check (name is null or char_length(name) <= 60),
  email text check (email is null or char_length(email) <= 120),
  message text not null check (char_length(message) between 1 and 2000),
  page text,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists feedback_ip_time on public.feedback (ip_hash, created_at desc);
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;
create policy "admins read feedback" on public.feedback for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin));
grant select on public.feedback to authenticated;
