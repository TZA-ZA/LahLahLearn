-- Lets the private admin page save the AI settings (such as the Anthropic API key) into Supabase Vault
-- as "app.<NAME>", which the edge functions already read as a fallback for missing function secrets.
-- Only the service role can call these; the admin-settings function checks the caller is a team admin first.
create or replace function public.set_app_setting(p_name text, p_value text) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  if p_name !~ '^[A-Z][A-Z0-9_]{1,62}$' then raise exception 'bad setting name'; end if;
  select id into sid from vault.secrets where name = 'app.' || p_name;
  if coalesce(p_value, '') = '' then
    if sid is not null then delete from vault.secrets where id = sid; end if;
  elsif sid is null then
    perform vault.create_secret(p_value, 'app.' || p_name, 'Set from the LahLahLearn admin page');
  else
    perform vault.update_secret(sid, p_value);
  end if;
end $$;
revoke execute on function public.set_app_setting(text, text) from public, anon, authenticated;
grant execute on function public.set_app_setting(text, text) to service_role;
