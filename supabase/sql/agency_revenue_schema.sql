-- =============================================================================
-- TikTok Shop 代理店: agencies / profiles / creators / sales_imports
-- Supabase SQL Editor に貼り付けて実行（既存の同名 public テーブルと競合する場合は DROP 済み）
-- commission_rate: パーセント値（例: 5 = 5%）。代理店報酬 = profit_amount * commission_rate / 100
-- =============================================================================

create extension if not exists "pgcrypto";

-- 依存順に削除（旧スキーマの creators / sales 等がある場合）
drop table if exists public.sales_imports cascade;
drop table if exists public.creators cascade;
drop table if exists public.profiles cascade;
drop table if exists public.agencies cascade;

-- ---------------------------------------------------------------------------
-- agencies
-- ---------------------------------------------------------------------------
create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null default '代理店',
  created_at timestamptz not null default now()
);

comment on table public.agencies is '代理店（テナント）';

-- ---------------------------------------------------------------------------
-- profiles（auth.users と 1:1、代理店紐付け）
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  agency_id uuid references public.agencies (id) on delete restrict,
  role text not null default 'agency' check (role in ('admin', 'agency')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'ログインユーザーと代理店の紐付け';

create index profiles_agency_id_idx on public.profiles (agency_id);

-- ---------------------------------------------------------------------------
-- creators（紹介クリエイター）
-- ---------------------------------------------------------------------------
create table public.creators (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies (id) on delete cascade,
  creator_name text not null,
  tiktok_id text not null,
  commission_rate numeric(10, 4) not null default 5,
  created_at timestamptz not null default now(),
  constraint creators_agency_tiktok_unique unique (agency_id, tiktok_id)
);

comment on table public.creators is '紹介クリエイター';
comment on column public.creators.commission_rate is '収益分配率（%）。例: 5 = 5%';
comment on column public.creators.tiktok_id is '小文字正規化推奨（アプリ側）';

create index creators_agency_id_idx on public.creators (agency_id);

-- ---------------------------------------------------------------------------
-- sales_imports（CSV 取込行。クリエイター×対象月は一意に UPSERT）
-- ---------------------------------------------------------------------------
create table public.sales_imports (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators (id) on delete cascade,
  agency_id uuid not null references public.agencies (id) on delete cascade,
  target_month text not null,
  sales_amount numeric(16, 2) not null default 0,
  profit_amount numeric(16, 2) not null default 0,
  commission_base numeric(16, 2) not null default 0,
  order_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint sales_imports_month_format check (target_month ~ '^\d{4}-\d{2}$'),
  constraint sales_imports_creator_month_unique unique (creator_id, target_month)
);

comment on table public.sales_imports is '売上 CSV 取込（月次・クリエイター別）';

create index sales_imports_agency_month_idx on public.sales_imports (agency_id, target_month);
create index sales_imports_created_at_idx on public.sales_imports (created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.agencies enable row level security;
alter table public.profiles enable row level security;
alter table public.creators enable row level security;
alter table public.sales_imports enable row level security;

-- agencies: 自分のプロファイルが参照する代理店のみ
create policy "agencies_select_member"
  on public.agencies for select
  using (
    id in (select agency_id from public.profiles where id = auth.uid() and agency_id is not null)
  );

create policy "agencies_insert_authenticated"
  on public.agencies for insert
  to authenticated
  with check (true);

create policy "agencies_update_member"
  on public.agencies for update
  using (
    id in (select agency_id from public.profiles where id = auth.uid())
  );

-- profiles: 自分のみ
create policy "profiles_select_own"
  on public.profiles for select using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update using (auth.uid() = id);

-- creators: 同一代理店のみ
create policy "creators_select_agency"
  on public.creators for select
  using (
    agency_id in (select agency_id from public.profiles where id = auth.uid())
  );

create policy "creators_insert_agency"
  on public.creators for insert
  with check (
    agency_id in (select agency_id from public.profiles where id = auth.uid())
  );

create policy "creators_update_agency"
  on public.creators for update
  using (
    agency_id in (select agency_id from public.profiles where id = auth.uid())
  );

create policy "creators_delete_agency"
  on public.creators for delete
  using (
    agency_id in (select agency_id from public.profiles where id = auth.uid())
  );

-- sales_imports: 同一代理店のみ
create policy "sales_imports_select_agency"
  on public.sales_imports for select
  using (
    agency_id in (select agency_id from public.profiles where id = auth.uid())
  );

create policy "sales_imports_insert_agency"
  on public.sales_imports for insert
  with check (
    agency_id in (select agency_id from public.profiles where id = auth.uid())
  );

create policy "sales_imports_update_agency"
  on public.sales_imports for update
  using (
    agency_id in (select agency_id from public.profiles where id = auth.uid())
  );

create policy "sales_imports_delete_agency"
  on public.sales_imports for delete
  using (
    agency_id in (select agency_id from public.profiles where id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant usage on schema public to postgres, anon, authenticated, service_role;

grant select, insert, update, delete on public.agencies to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.creators to authenticated;
grant select, insert, update, delete on public.sales_imports to authenticated;
