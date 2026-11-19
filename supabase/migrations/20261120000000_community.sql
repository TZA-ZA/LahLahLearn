-- Community boards: "Kids' corner" (children share what they learned) and "Parents' voices" (feedback from families).
-- Everyone can read visible posts; signed-in users post as themselves; two reports hide a post until an admin looks at it.
create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  board text not null check (board in ('kids','parents')),
  author_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 40),
  avatar text check (avatar is null or char_length(avatar) <= 16),
  sticker text check (sticker is null or char_length(sticker) <= 24),
  body text not null check (char_length(body) between 1 and 500),
  rating int check (rating between 1 and 5),
  reports int not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists community_posts_board_time on public.community_posts (board, created_at desc) where not hidden;
alter table public.community_posts enable row level security;

create policy "anyone reads visible posts" on public.community_posts for select using (not hidden);
create policy "users post as themselves" on public.community_posts for insert to authenticated
  with check (author_id = auth.uid() and not hidden and reports = 0);
create policy "users delete their own posts" on public.community_posts for delete to authenticated using (author_id = auth.uid());
grant select on public.community_posts to anon, authenticated;
grant insert, delete on public.community_posts to authenticated;

-- no personal details (phone numbers, emails, links) and at most 10 posts a day per person
create or replace function public.community_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.body ~* '(\d[\d\s-]{6,}\d|@|https?://|www\.|whatsapp|instagram|tiktok|telegram|snapchat)' then
    raise exception 'Please do not share phone numbers, emails or links.';
  end if;
  if (select count(*) from public.community_posts where author_id = new.author_id and created_at > now() - interval '1 day') >= 10 then
    raise exception 'That is a lot of posts today. Please try again tomorrow.';
  end if;
  return new;
end $$;
drop trigger if exists community_check on public.community_posts;
create trigger community_check before insert on public.community_posts for each row execute function public.community_check();

-- report a post: after two reports it is hidden until an admin checks it
create or replace function public.community_report(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.community_posts set reports = reports + 1, hidden = (reports + 1 >= 2) where id = p_id;
$$;
revoke all on function public.community_report(uuid) from public;
grant execute on function public.community_report(uuid) to authenticated;

-- each person can report a post once, so one person alone cannot hide a post
create table if not exists public.community_reports(
  post_id uuid not null references public.community_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id));
create index if not exists community_reports_user on public.community_reports(user_id);
alter table public.community_reports enable row level security;
revoke all on public.community_reports from anon, authenticated;
create or replace function public.community_report(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in.'; end if;
  insert into public.community_reports(post_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
  if found then
    update public.community_posts set reports = reports + 1, hidden = (reports + 1 >= 2) where id = p_id;
  end if;
end $$;
revoke all on function public.community_report(uuid) from public, anon;
grant execute on function public.community_report(uuid) to authenticated;
