-- Essentials plan ("learn"): every lesson and the Care Circle, without Pip AI. Paid through Stripe prices learn_<n>_<cycle>.
alter table public.families drop constraint if exists families_plan_check;
alter table public.families add constraint families_plan_check check (plan in ('free','learn','family','school'));

create or replace function public.effective_plan(f public.families) returns text
language sql stable set search_path = public as $$
  select case
    when f.plan = 'school' and f.plan_status in ('active','trialing','past_due') then 'school'
    when f.plan = 'family' and f.plan_status in ('active','trialing','past_due') then 'family'
    when f.plan = 'learn'  and f.plan_status in ('active','trialing','past_due') then 'learn'
    when f.trial_ends_at is not null and f.trial_ends_at > now() then 'family'
    else 'free' end
$$;
