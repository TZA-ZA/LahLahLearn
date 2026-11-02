-- Trigger functions are never called directly.
revoke execute on function public.appointments_guard(), public.children_guard(), public.handle_new_user(),
  public.members_guard(), public.set_family_from_child(), public.sync_daily_activity(), public.touch_updated_at()
  from authenticated, anon, public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Server settings kept in Supabase Vault. A vault secret named "app.STRIPE_SECRET_KEY" is read by the
-- edge functions as STRIPE_SECRET_KEY when no function secret of that name is set.
-- Only the service role (edge functions) can call this.
create or replace function public.get_app_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare out jsonb;
begin
  if to_regclass('vault.decrypted_secrets') is null then return '{}'::jsonb; end if;
  execute $q$ select coalesce(jsonb_object_agg(substr(name, 5), decrypted_secret), '{}'::jsonb)
              from vault.decrypted_secrets where name like 'app.%' $q$ into out;
  return out;
end $$;
revoke execute on function public.get_app_settings() from public, anon, authenticated;
grant execute on function public.get_app_settings() to service_role;

-- Weekly reports: every day at 01:00 UTC (09:00 Malaysia) call the weekly-report function, which
-- emails every family whose chosen report day is today. Uses pg_cron + pg_net when available.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    perform cron.schedule('lll-weekly-report', '0 1 * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'app.FUNCTIONS_URL') || '/weekly-report',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'app.CRON_SECRET')),
        body := '{"mode":"cron"}'::jsonb,
        timeout_milliseconds := 60000)
    $job$);
  end if;
end $do$;
