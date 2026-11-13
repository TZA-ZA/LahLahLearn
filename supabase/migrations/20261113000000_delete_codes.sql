-- One-time email codes that confirm an account deletion. Only server functions (service role) touch this table.
create table if not exists public.delete_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.delete_codes enable row level security;
revoke all on public.delete_codes from anon, authenticated;
