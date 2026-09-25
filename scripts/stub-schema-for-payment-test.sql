-- =============================================================================
-- 支払明細 RPC 検証用のスタブスキーマ（使い捨てDB専用）
-- =============================================================================
-- 本番スキーマのうち、支払管理が触れるテーブルだけを最小再現したもの。
-- 本番DBでは絶対に実行しないこと（既存テーブルと衝突する）。
--
-- is_app_admin() / auth.uid() は current_setting でテストから切り替えられる
-- スタブに置き換えてある。本番の実装とは別物。
--
-- 使い方:
--   createdb paytest
--   psql -d paytest -f scripts/stub-schema-for-payment-test.sql
--   psql -d paytest -f supabase/migrations/20260925100000_payee_bank_accounts.sql
--   psql -d paytest -f supabase/migrations/20260925101000_payment_batches.sql
--   psql -d paytest -f supabase/migrations/20260925102000_reward_items_payment_batch.sql
--   psql -d paytest -f supabase/migrations/20260925103000_payment_batch_rpc.sql
--   psql -d paytest -v ON_ERROR_STOP=1 -f scripts/verify-payment-batch-rpc.sql
-- =============================================================================
-- ロールはクラスタ単位なので、既に存在していれば作らない
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$roles$;

create schema if not exists auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- テスト用に current_setting で切り替えられるスタブ
create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('test.uid', true), '')::uuid;
$fn$;

create or replace function public.is_app_admin() returns boolean
language sql stable as $fn$
  select coalesce(nullif(current_setting('test.is_admin', true), '')::boolean, false);
$fn$;

-- ---------------------------------------------------------------- agencies
create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  default_commission_rate numeric,
  is_active boolean default true,
  is_in_house boolean default false
);
-- 本番と同じくRLS無効 + テーブル単位grant
grant delete, insert, references, select, trigger, truncate, update
  on public.agencies to authenticated;

-- ---------------------------------------------------------------- referrers
create table public.referrers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  name text,
  referrer_name text,
  email text,
  phone text,
  line_id text,
  bank_name text,
  bank_branch_name text,
  bank_account_type text,
  bank_account_number text,
  bank_account_holder text,
  memo text,
  referral_code text,
  is_active boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_in_house boolean default false
);
alter table public.referrers enable row level security;
create policy "referrers_admin_all" on public.referrers for all
  using (public.is_app_admin()) with check (public.is_app_admin());
grant delete, insert, references, select, trigger, truncate, update
  on public.referrers to authenticated;

-- ---------------------------------------------------------------- creators
create table public.creators (
  id uuid primary key default gen_random_uuid(),
  creator_name text,
  tiktok_id text,
  agency_id uuid references public.agencies(id),
  account_management_type text,
  referred_by_referrer_id uuid references public.referrers(id),
  commission_rate numeric default 0
);

create table public.creator_referrals (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  referrer_id uuid not null references public.referrers(id) on delete cascade,
  referral_rate numeric default 0.05,
  start_month text,
  end_month text,
  is_active boolean default true,
  lifetime_payout_cap numeric,
  lifetime_paid_amount numeric default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------- agency payouts
create table public.agency_payouts (
  id uuid primary key default gen_random_uuid(),
  target_month text not null,
  reward_year text generated always as (left(target_month, 4)) stored,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  total_reward_amount numeric not null default 0,
  threshold_amount numeric not null default 0,
  is_payable boolean not null default false,
  status text not null default 'hold',
  paid_at timestamptz,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agency_payouts_target_month_check check (target_month ~ '^\d{4}-\d{2}$'),
  constraint agency_payouts_status_check check (status in ('hold','unpaid','paid')),
  constraint agency_payouts_month_agency_unique unique (target_month, agency_id)
);

create table public.agency_reward_items (
  id uuid primary key default gen_random_uuid(),
  source_row_key text not null,
  target_month text not null,
  reward_year text generated always as (left(target_month, 4)) stored,
  order_id text not null default '',
  product_id text not null default '',
  creator_id uuid not null references public.creators(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  agency_source text,
  commission_base numeric not null default 0,
  commission_gmv numeric not null default 0,
  creator_revenue_before_split numeric not null default 0,
  agency_split_rate numeric not null default 0,
  reward_amount numeric not null default 0,
  payment_status text,
  order_status text,
  refund_status text,
  is_reward_target boolean not null default true,
  is_paid boolean not null default false,
  paid_at timestamptz,
  payout_id uuid references public.agency_payouts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agency_reward_items_target_month_check check (target_month ~ '^\d{4}-\d{2}$')
);
create unique index agency_reward_items_source_row_key_unique
  on public.agency_reward_items (source_row_key);

-- -------------------------------------------------------- referral payouts
create table public.referral_payouts (
  id uuid primary key default gen_random_uuid(),
  target_month text not null,
  referrer_id uuid not null references public.referrers(id) on delete cascade,
  total_reward_amount numeric not null default 0,
  threshold_amount numeric not null default 1000,
  is_payable boolean not null default false,
  status text not null default 'hold',
  paid_at timestamptz,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reward_year text generated always as (left(target_month, 4)) stored,
  constraint referral_payouts_target_month_check check (target_month ~ '^\d{4}-\d{2}$'),
  constraint referral_payouts_status_check check (status in ('hold','unpaid','paid')),
  constraint referral_payouts_month_referrer_unique unique (target_month, referrer_id)
);

create table public.referral_reward_items (
  id uuid primary key default gen_random_uuid(),
  target_month text not null,
  order_id text not null,
  product_id text not null default '',
  creator_id uuid not null references public.creators(id) on delete cascade,
  referrer_id uuid not null references public.referrers(id) on delete cascade,
  base_amount numeric not null default 0,
  reward_rate numeric not null default 0.05,
  original_reward_amount numeric not null default 0,
  adjusted_reward_amount numeric not null default 0,
  reward_amount numeric not null default 0,
  cap_applied boolean not null default false,
  cap_reached boolean not null default false,
  payment_status text,
  order_status text,
  refund_status text,
  is_reward_target boolean not null default false,
  is_paid boolean not null default false,
  paid_at timestamptz,
  payout_id uuid references public.referral_payouts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source_row_key text,
  reward_year text generated always as (left(target_month, 4)) stored,
  constraint referral_reward_items_target_month_check check (target_month ~ '^\d{4}-\d{2}$')
);
create unique index referral_reward_items_source_row_key_unique
  on public.referral_reward_items (source_row_key);

alter table public.agency_reward_items enable row level security;
alter table public.agency_payouts enable row level security;
alter table public.referral_reward_items enable row level security;
alter table public.referral_payouts enable row level security;

create policy "agency_reward_items_admin_write" on public.agency_reward_items for all
  using (public.is_app_admin()) with check (public.is_app_admin());
create policy "agency_payouts_admin_write" on public.agency_payouts for all
  using (public.is_app_admin()) with check (public.is_app_admin());
create policy "referral_reward_items_admin_write" on public.referral_reward_items for all
  using (public.is_app_admin()) with check (public.is_app_admin());
create policy "referral_payouts_admin_write" on public.referral_payouts for all
  using (public.is_app_admin()) with check (public.is_app_admin());

grant select on public.agency_reward_items, public.agency_payouts,
  public.referral_reward_items, public.referral_payouts to authenticated;
grant all on public.agency_reward_items, public.agency_payouts,
  public.referral_reward_items, public.referral_payouts to service_role;
