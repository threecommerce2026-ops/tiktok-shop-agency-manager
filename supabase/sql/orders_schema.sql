-- =============================================================================
-- TikTok Shop 注文テーブル（orders）
-- Supabase SQL Editor に貼り付けて実行
-- 前提: public.is_app_admin() が定義済み（roles_and_ops_schema.sql）
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- updated_at 自動更新
-- ---------------------------------------------------------------------------
create or replace function public.set_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- creators.agency_id から orders.agency_id を同期
-- ---------------------------------------------------------------------------
create or replace function public.sync_orders_agency_id_from_creator()
returns trigger
language plpgsql
as $$
begin
  if new.creator_id is not null then
    select c.agency_id
    into new.agency_id
    from public.creators c
    where c.id = new.creator_id;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  creator_id uuid,
  agency_id uuid,
  creator_name text,
  creator_tiktok_id text not null,
  product_id text,
  product_name text,
  sku text,
  order_amount numeric(16, 2) not null default 0,
  commission_base numeric(16, 2) not null default 0,
  commission_amount numeric(16, 2) not null default 0,
  payment_status text,
  order_status text,
  shipping_status text,
  cancel_status text,
  refund_status text,
  is_commission_target boolean not null default false,
  ordered_at timestamptz,
  paid_at timestamptz,
  target_month text not null,
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_order_id_unique unique (order_id),
  constraint orders_target_month_format check (target_month ~ '^\d{4}-\d{2}$')
);

comment on table public.orders is 'TikTok Shop 注文（Order API / 将来 CSV 統合）';
comment on column public.orders.order_id is 'TikTok Shop 注文 ID（upsert キー）';
comment on column public.orders.agency_id is '所属代理店。creators.agency_id から自動同期';
comment on column public.orders.commission_base is '報酬計算ベース金額';
comment on column public.orders.commission_amount is '注文に紐づくコミッション金額';
comment on column public.orders.is_commission_target is '代理店報酬計算対象フラグ';
comment on column public.orders.raw_json is 'Order API レスポンス原文';

alter table public.orders
  add column if not exists agency_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_creator_id_fkey'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_creator_id_fkey
      foreign key (creator_id)
      references public.creators (id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_agency_id_fkey'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_agency_id_fkey
      foreign key (agency_id)
      references public.agencies (id)
      on delete set null;
  end if;
end;
$$;

create index if not exists orders_creator_id_idx
  on public.orders (creator_id);

create index if not exists orders_agency_id_idx
  on public.orders (agency_id);

create index if not exists orders_agency_month_idx
  on public.orders (agency_id, target_month);

create index if not exists orders_creator_tiktok_id_idx
  on public.orders (creator_tiktok_id);

create index if not exists orders_target_month_idx
  on public.orders (target_month);

create index if not exists orders_payment_status_idx
  on public.orders (payment_status);

create index if not exists orders_is_commission_target_idx
  on public.orders (is_commission_target);

create index if not exists orders_ordered_at_idx
  on public.orders (ordered_at desc);

update public.orders o
set agency_id = c.agency_id
from public.creators c
where o.creator_id = c.id
  and o.agency_id is distinct from c.agency_id;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row
  execute function public.set_orders_updated_at();

drop trigger if exists orders_sync_agency_id_from_creator on public.orders;
create trigger orders_sync_agency_id_from_creator
  before insert or update of creator_id on public.orders
  for each row
  execute function public.sync_orders_agency_id_from_creator();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.orders enable row level security;

drop policy if exists "orders_select_admin_or_agency" on public.orders;
create policy "orders_select_admin_or_agency"
  on public.orders for select
  using (
    public.is_app_admin()
    or agency_id in (
      select p.agency_id
      from public.profiles p
      where p.id = auth.uid()
        and p.agency_id is not null
    )
  );

drop policy if exists "orders_insert_admin" on public.orders;
create policy "orders_insert_admin"
  on public.orders for insert
  with check (public.is_app_admin());

drop policy if exists "orders_update_admin" on public.orders;
create policy "orders_update_admin"
  on public.orders for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update on public.orders to authenticated;
