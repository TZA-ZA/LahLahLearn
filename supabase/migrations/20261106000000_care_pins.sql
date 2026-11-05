-- The parent's Care Circle PIN, saved so it works on every device. Only the salted hash is stored,
-- and only the owner can read it (other Care Circle members cannot).
create table if not exists public.care_pins (
  user_id     uuid not null references auth.users(id) on delete cascade,
  family_id   uuid not null references public.families(id) on delete cascade,
  name        text not null default '' check (char_length(name) <= 80),
  salt        text not null check (char_length(salt) <= 64),
  h           text not null check (char_length(h) <= 128),
  rs          text check (char_length(rs) <= 64),
  rh          text check (char_length(rh) <= 128),
  updated_at  timestamptz not null default now(),
  primary key (user_id, family_id)
);
alter table public.care_pins enable row level security;
revoke all on public.care_pins from anon;
grant select, insert, update, delete on public.care_pins to authenticated;
grant all on public.care_pins to service_role;
create policy "own pin read" on public.care_pins for select to authenticated using (user_id = auth.uid());
create policy "own pin write" on public.care_pins for insert to authenticated with check (user_id = auth.uid() and public.is_member(family_id));
create policy "own pin update" on public.care_pins for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(family_id));
create policy "own pin delete" on public.care_pins for delete to authenticated using (user_id = auth.uid());
create trigger care_pins_touch before update on public.care_pins for each row execute function public.touch_updated_at();
