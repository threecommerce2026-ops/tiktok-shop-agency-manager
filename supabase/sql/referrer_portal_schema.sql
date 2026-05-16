-- =============================================================================
-- 紹介者ポータル: 紹介リンク / ログイン / ダッシュボード
-- 前提: admin_referrals_schema.sql 実行済み
-- =============================================================================

create extension if not exists "pgcrypto";

alter table public.referrers
  add column if not exists user_id uuid references auth.users (id) on delete set null;

alter table public.referrers
  add column if not exists referral_code text;

alter table public.referrers
  add column if not exists bank_name text;

alter table public.referrers
  add column if not exists bank_branch_name text;

alter table public.referrers
  add column if not exists bank_account_type text;

alter table public.referrers
  add column if not exists bank_account_number text;

alter table public.referrers
  add column if not exists bank_account_holder text;

alter table public.referrers
  add column if not exists line_id text;

alter table public.referrers
  add column if not exists line_user_id text;

create unique index if not exists referrers_referral_code_unique
  on public.referrers (referral_code)
  where referral_code is not null;

create unique index if not exists referrers_user_id_unique
  on public.referrers (user_id)
  where user_id is not null;

create index if not exists referrers_email_idx
  on public.referrers (lower(email));

comment on column public.referrers.referral_code is '紹介リンク用コード';
comment on column public.referrers.line_user_id is '将来の LINE Messaging API 連携用';

alter table public.creators
  add column if not exists registration_status text not null default 'assigned';

alter table public.creators
  add column if not exists real_name text;

alter table public.creators
  add column if not exists email text;

alter table public.creators
  add column if not exists phone text;

alter table public.creators
  add column if not exists line_display_name text;

alter table public.creators
  add column if not exists official_line_connected boolean not null default false;

alter table public.creators
  add column if not exists line_user_id text;

alter table public.creators
  add column if not exists referred_by_referrer_id uuid references public.referrers (id) on delete set null;

alter table public.creators
  drop constraint if exists creators_registration_status_check;

alter table public.creators
  add constraint creators_registration_status_check
  check (registration_status in ('pending', 'assigned', 'inactive'));

comment on column public.creators.registration_status is 'pending=紹介リンク経由未振り分け, assigned=運用中';

create table if not exists public.referral_line_identities (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid references public.referrers (id) on delete set null,
  creator_id uuid references public.creators (id) on delete set null,
  line_user_id text not null,
  line_display_name text,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_line_identities_line_user_id_unique unique (line_user_id)
);

comment on table public.referral_line_identities is '将来の LINE Messaging API 連携用';

create index if not exists referral_line_identities_referrer_idx
  on public.referral_line_identities (referrer_id);

create index if not exists referral_line_identities_creator_idx
  on public.referral_line_identities (creator_id);

create or replace function public.current_referrer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select r.id
  from public.referrers r
  where r.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.is_referrer_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_referrer_id() is not null;
$$;

drop trigger if exists referral_line_identities_set_updated_at on public.referral_line_identities;
create trigger referral_line_identities_set_updated_at
  before update on public.referral_line_identities
  for each row
  execute function public.set_admin_referral_updated_at();

alter table public.referral_line_identities enable row level security;

drop policy if exists "referrers_select_self_or_admin" on public.referrers;
create policy "referrers_select_self_or_admin"
  on public.referrers for select
  using (public.is_app_admin() or user_id = auth.uid());

drop policy if exists "referrers_update_self_or_admin" on public.referrers;
create policy "referrers_update_self_or_admin"
  on public.referrers for update
  using (public.is_app_admin() or user_id = auth.uid())
  with check (public.is_app_admin() or user_id = auth.uid());

drop policy if exists "referrers_insert_self_or_admin" on public.referrers;
create policy "referrers_insert_self_or_admin"
  on public.referrers for insert
  with check (public.is_app_admin() or user_id = auth.uid());

drop policy if exists "referrers_admin_all" on public.referrers;

drop policy if exists "creator_referrals_select_referrer_or_admin" on public.creator_referrals;
create policy "creator_referrals_select_referrer_or_admin"
  on public.creator_referrals for select
  using (
    public.is_app_admin()
    or referrer_id = public.current_referrer_id()
  );

drop policy if exists "creator_referrals_admin_all" on public.creator_referrals;

drop policy if exists "creator_referrals_admin_write" on public.creator_referrals;
create policy "creator_referrals_admin_write"
  on public.creator_referrals for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "referral_reward_items_select_referrer_or_admin" on public.referral_reward_items;
create policy "referral_reward_items_select_referrer_or_admin"
  on public.referral_reward_items for select
  using (
    public.is_app_admin()
    or referrer_id = public.current_referrer_id()
  );

drop policy if exists "referral_reward_items_admin_all" on public.referral_reward_items;

drop policy if exists "referral_reward_items_admin_write" on public.referral_reward_items;
create policy "referral_reward_items_admin_write"
  on public.referral_reward_items for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "referral_payouts_select_referrer_or_admin" on public.referral_payouts;
create policy "referral_payouts_select_referrer_or_admin"
  on public.referral_payouts for select
  using (
    public.is_app_admin()
    or referrer_id = public.current_referrer_id()
  );

drop policy if exists "referral_payouts_admin_all" on public.referral_payouts;

drop policy if exists "referral_payouts_admin_write" on public.referral_payouts;
create policy "referral_payouts_admin_write"
  on public.referral_payouts for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "creators_select_referrer_linked" on public.creators;
create policy "creators_select_referrer_linked"
  on public.creators for select
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
    or id in (
      select cr.creator_id
      from public.creator_referrals cr
      where cr.referrer_id = public.current_referrer_id()
        and cr.is_active = true
    )
  );

drop policy if exists "orders_select_referrer_linked" on public.orders;
create policy "orders_select_referrer_linked"
  on public.orders for select
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
    or creator_id in (
      select cr.creator_id
      from public.creator_referrals cr
      where cr.referrer_id = public.current_referrer_id()
        and cr.is_active = true
    )
  );

drop policy if exists "referral_line_identities_admin_all" on public.referral_line_identities;
create policy "referral_line_identities_admin_all"
  on public.referral_line_identities for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "referral_line_identities_select_self" on public.referral_line_identities;
create policy "referral_line_identities_select_self"
  on public.referral_line_identities for select
  using (referrer_id = public.current_referrer_id());

grant select, insert, update on public.referral_line_identities to authenticated;
