-- Test-only: the bits of a Supabase project that the migration relies on (roles, auth schema, default grants).
-- Never run this on a real Supabase project; it already has all of this.
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users(
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create or replace function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(auth.jwt()->>'sub','')::uuid $$;
create or replace function auth.email() returns text language sql stable as
$$ select auth.jwt()->>'email' $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
