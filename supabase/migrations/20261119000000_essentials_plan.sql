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

-- Add-ons an Essentials family pays for: {"world":true,"care":true,"reports":true,"checkups":true,"ai":true}.
-- Written only by the Stripe webhook / billing function (service role).
alter table public.families add column if not exists features jsonb not null default '{}'::jsonb;
revoke update (features) on public.families from authenticated;

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
        'features', f.features,
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
