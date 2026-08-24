-- =============================================================================
-- 親管理者向け: 代理店拡張 / 紹介者 / クリエイター紹介 / 紹介者報酬支払い
-- 前提: public.is_app_admin() が定義済み（roles_and_ops_schema.sql）
-- =============================================================================

create extension if not exists "pgcrypto";

create or replace function public.set_admin_referral_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table public.agencies
  add column if not exists is_active boolean not null default true;

comment on column public.agencies.is_active is '代理店を有効として扱うか';

create table if not exists public.referrers (
  id uuid primary key default gen_random_uuid(),
  referrer_name text not null,
  email text,
  phone text,
  memo text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.referrers add column if not exists referrer_name text;
alter table public.referrers add column if not exists email text;
alter table public.referrers add column if not exists phone text;
alter table public.referrers add column if not exists memo text;
alter table public.referrers add column if not exists is_active boolean not null default true;
alter table public.referrers add column if not exists created_at timestamptz not null default now();
alter table public.referrers add column if not exists updated_at timestamptz not null default now();

update public.referrers
set referrer_name = coalesce(nullif(trim(referrer_name), ''), nullif(trim(name), ''), '未設定')
where referrer_name is null or trim(referrer_name) = '';

update public.referrers
set email = coalesce(email, contact_email)
where email is null and contact_email is not null;

update public.referrers
set memo = coalesce(memo, notes)
where memo is null and notes is not null;

alter table public.referrers
  alter column referrer_name set not null;

comment on table public.referrers is 'THREE.inc 自社クリエイター向け紹介者（親管理者のみ）';

create table if not exists public.creator_referrals (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators (id) on delete cascade,
  referrer_id uuid not null references public.referrers (id) on delete restrict,
  referral_rate numeric(10, 4) not null default 0.05,
  start_month text not null,
  end_month text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_referrals_start_month_format check (start_month ~ '^\d{4}-\d{2}$'),
  constraint creator_referrals_end_month_format check (
    end_month is null or end_month ~ '^\d{4}-\d{2}$'
  )
);

comment on table public.creator_referrals is '自社クリエイターと紹介者の紐付け';
comment on column public.creator_referrals.referral_rate is '紹介報酬率（0.05 = 5%）';

create index if not exists creator_referrals_creator_idx
  on public.creator_referrals (creator_id, is_active);

create index if not exists creator_referrals_referrer_idx
  on public.creator_referrals (referrer_id, is_active);

create table if not exists public.referral_reward_items (
  id uuid primary key default gen_random_uuid(),
  target_month text not null,
  order_id text not null,
  product_id text not null default '',
  creator_id uuid not null references public.creators (id) on delete cascade,
  referrer_id uuid not null references public.referrers (id) on delete restrict,
  base_amount numeric(16, 2) not null default 0,
  reward_rate numeric(10, 4) not null default 0.05,
  reward_amount numeric(16, 2) not null default 0,
  payment_status text,
  order_status text,
  refund_status text,
  is_reward_target boolean not null default false,
  is_paid boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_reward_items_month_format check (target_month ~ '^\d{4}-\d{2}$'),
  constraint referral_reward_items_unique unique (
    target_month,
    order_id,
    product_id,
    creator_id,
    referrer_id
  )
);

comment on table public.referral_reward_items is '紹介者報酬明細（二重支払い防止）';

create index if not exists referral_reward_items_month_referrer_idx
  on public.referral_reward_items (target_month, referrer_id);

create index if not exists referral_reward_items_paid_idx
  on public.referral_reward_items (is_paid, target_month);

create table if not exists public.referral_payouts (
  id uuid primary key default gen_random_uuid(),
  target_month text not null,
  referrer_id uuid not null references public.referrers (id) on delete restrict,
  total_reward_amount numeric(16, 2) not null default 0,
  threshold_amount numeric(16, 2) not null default 1000,
  is_payable boolean not null default false,
  status text not null default 'unpaid',
  paid_at timestamptz,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_payouts_month_format check (target_month ~ '^\d{4}-\d{2}$'),
  constraint referral_payouts_status_check check (status in ('unpaid', 'paid', 'hold')),
  constraint referral_payouts_unique unique (target_month, referrer_id)
);

comment on table public.referral_payouts is '紹介者への月次支払い管理';

create index if not exists referral_payouts_month_status_idx
  on public.referral_payouts (target_month, status);

drop trigger if exists referrers_set_updated_at on public.referrers;
create trigger referrers_set_updated_at
  before update on public.referrers
  for each row
  execute function public.set_admin_referral_updated_at();

drop trigger if exists creator_referrals_set_updated_at on public.creator_referrals;
create trigger creator_referrals_set_updated_at
  before update on public.creator_referrals
  for each row
  execute function public.set_admin_referral_updated_at();

drop trigger if exists referral_reward_items_set_updated_at on public.referral_reward_items;
create trigger referral_reward_items_set_updated_at
  before update on public.referral_reward_items
  for each row
  execute function public.set_admin_referral_updated_at();

drop trigger if exists referral_payouts_set_updated_at on public.referral_payouts;
create trigger referral_payouts_set_updated_at
  before update on public.referral_payouts
  for each row
  execute function public.set_admin_referral_updated_at();

alter table public.referrers enable row level security;
alter table public.creator_referrals enable row level security;
alter table public.referral_reward_items enable row level security;
alter table public.referral_payouts enable row level security;

drop policy if exists "referrers_admin_all" on public.referrers;
create policy "referrers_admin_all"
  on public.referrers for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "creator_referrals_admin_all" on public.creator_referrals;
create policy "creator_referrals_admin_all"
  on public.creator_referrals for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "referral_reward_items_admin_all" on public.referral_reward_items;
create policy "referral_reward_items_admin_all"
  on public.referral_reward_items for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "referral_payouts_admin_all" on public.referral_payouts;
create policy "referral_payouts_admin_all"
  on public.referral_payouts for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

grant select, insert, update, delete on public.referrers to authenticated;
grant select, insert, update, delete on public.creator_referrals to authenticated;
grant select, insert, update, delete on public.referral_reward_items to authenticated;
grant select, insert, update, delete on public.referral_payouts to authenticated;
