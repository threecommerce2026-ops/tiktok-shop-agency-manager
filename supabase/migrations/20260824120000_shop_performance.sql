-- =============================================================================
-- Partner Center ショップ分析 (Shop ranking) 取込 + TSP請求プレビュー
-- feature branch 用。本番適用は別途承認後。
-- 前提: public.is_app_admin(), public.sellers
-- =============================================================================

create extension if not exists "pgcrypto";

-- sellers.shop_id（将来 API 用。XLSX 取込では必須ではない）
alter table public.sellers
  add column if not exists shop_id text;

create unique index if not exists sellers_shop_id_unique
  on public.sellers (shop_id)
  where shop_id is not null;

comment on column public.sellers.shop_id is
  'TikTok Shop の shop_id（将来 Seller/Open API 接続用）。ShopList XLSX には含まれない';

-- ---------------------------------------------------------------------------
-- seller_shop_aliases: エクスポート上の Shop name ↔ seller
-- ---------------------------------------------------------------------------
create table if not exists public.seller_shop_aliases (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers (id) on delete cascade,
  alias_shop_name text not null,
  alias_normalized text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_shop_aliases_normalized_unique unique (alias_normalized)
);

comment on table public.seller_shop_aliases is
  'Partner Center エクスポートの Shop name と sellers の確定対応';

create index if not exists seller_shop_aliases_seller_id_idx
  on public.seller_shop_aliases (seller_id);

alter table public.seller_shop_aliases enable row level security;

drop policy if exists "seller_shop_aliases_admin_select" on public.seller_shop_aliases;
create policy "seller_shop_aliases_admin_select"
  on public.seller_shop_aliases for select
  using (public.is_app_admin());

drop policy if exists "seller_shop_aliases_admin_insert" on public.seller_shop_aliases;
create policy "seller_shop_aliases_admin_insert"
  on public.seller_shop_aliases for insert
  with check (public.is_app_admin());

drop policy if exists "seller_shop_aliases_admin_update" on public.seller_shop_aliases;
create policy "seller_shop_aliases_admin_update"
  on public.seller_shop_aliases for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "seller_shop_aliases_admin_delete" on public.seller_shop_aliases;
create policy "seller_shop_aliases_admin_delete"
  on public.seller_shop_aliases for delete
  using (public.is_app_admin());

grant select, insert, update, delete on public.seller_shop_aliases to authenticated;

-- ---------------------------------------------------------------------------
-- shop_performance_import_batches
-- ---------------------------------------------------------------------------
create table if not exists public.shop_performance_import_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  file_format text,
  period_start date not null,
  period_end date not null,
  row_total integer not null default 0,
  upserted_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  failure_reasons jsonb not null default '[]'::jsonb,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint shop_performance_import_batches_period_check
    check (period_end >= period_start),
  constraint shop_performance_import_batches_format_check
    check (file_format is null or file_format in ('csv', 'xlsx', 'xls'))
);

comment on table public.shop_performance_import_batches is
  'ショップ分析 XLSX/CSV 取込バッチ履歴';

create index if not exists shop_performance_import_batches_created_at_idx
  on public.shop_performance_import_batches (created_at desc);

alter table public.shop_performance_import_batches enable row level security;

drop policy if exists "shop_perf_batches_admin_select" on public.shop_performance_import_batches;
create policy "shop_perf_batches_admin_select"
  on public.shop_performance_import_batches for select
  using (public.is_app_admin());

drop policy if exists "shop_perf_batches_admin_insert" on public.shop_performance_import_batches;
create policy "shop_perf_batches_admin_insert"
  on public.shop_performance_import_batches for insert
  with check (public.is_app_admin());

drop policy if exists "shop_perf_batches_admin_update" on public.shop_performance_import_batches;
create policy "shop_perf_batches_admin_update"
  on public.shop_performance_import_batches for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "shop_perf_batches_admin_delete" on public.shop_performance_import_batches;
create policy "shop_perf_batches_admin_delete"
  on public.shop_performance_import_batches for delete
  using (public.is_app_admin());

grant select, insert, update, delete on public.shop_performance_import_batches to authenticated;

-- ---------------------------------------------------------------------------
-- shop_performance_imports
-- identity_key: seller:{uuid} | name:{normalized}
-- UNIQUE (identity_key, period_start, period_end)
-- ---------------------------------------------------------------------------
create table if not exists public.shop_performance_imports (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null,
  shop_name text not null,
  shop_name_normalized text not null,
  shop_id text,
  seller_id uuid references public.sellers (id) on delete set null,
  period_start date not null,
  period_end date not null,
  target_month text,
  gmv_amount numeric(18, 2) not null default 0,
  currency text not null default 'JPY',
  items_sold integer,
  live_gmv_amount numeric(18, 2),
  video_gmv_amount numeric(18, 2),
  affiliate_gmv_amount numeric(18, 2),
  avg_customers numeric(18, 4),
  refund_amount numeric(18, 2),
  impressions bigint,
  avg_visitors numeric(18, 4),
  avg_conversion_rate_pct numeric(10, 4),
  shop_ranking integer,
  revenue_percentage numeric(10, 4),
  raw_row_json jsonb not null default '{}'::jsonb,
  source text not null default 'csv',
  import_batch_id uuid references public.shop_performance_import_batches (id) on delete set null,
  imported_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shop_performance_imports_period_check
    check (period_end >= period_start),
  constraint shop_performance_imports_source_check
    check (source in ('csv', 'seller_api', 'partner_api')),
  constraint shop_performance_imports_month_format
    check (target_month is null or target_month ~ '^\d{4}-\d{2}$'),
  constraint shop_performance_imports_identity_period_unique
    unique (identity_key, period_start, period_end)
);

comment on table public.shop_performance_imports is
  'Partner Center ショップ分析のショップ別実績（正本）。TSP請求は gmv_amount × tsp_rate';
comment on column public.shop_performance_imports.identity_key is
  'seller:{seller_id} または name:{shop_name_normalized}';
comment on column public.shop_performance_imports.avg_conversion_rate_pct is
  'パーセント値（例: 28.73 = 28.73%）。0.2873 には正規化しない';
comment on column public.shop_performance_imports.source is
  '現正本の取得元。UNIQUE には含めない';

create index if not exists shop_performance_imports_period_idx
  on public.shop_performance_imports (period_start, period_end);
create index if not exists shop_performance_imports_seller_id_idx
  on public.shop_performance_imports (seller_id);
create index if not exists shop_performance_imports_normalized_idx
  on public.shop_performance_imports (shop_name_normalized);

create or replace function public.set_shop_performance_imports_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists shop_performance_imports_set_updated_at
  on public.shop_performance_imports;
create trigger shop_performance_imports_set_updated_at
  before update on public.shop_performance_imports
  for each row
  execute function public.set_shop_performance_imports_updated_at();

alter table public.shop_performance_imports enable row level security;

drop policy if exists "shop_perf_imports_admin_select" on public.shop_performance_imports;
create policy "shop_perf_imports_admin_select"
  on public.shop_performance_imports for select
  using (public.is_app_admin());

drop policy if exists "shop_perf_imports_admin_insert" on public.shop_performance_imports;
create policy "shop_perf_imports_admin_insert"
  on public.shop_performance_imports for insert
  with check (public.is_app_admin());

drop policy if exists "shop_perf_imports_admin_update" on public.shop_performance_imports;
create policy "shop_perf_imports_admin_update"
  on public.shop_performance_imports for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "shop_perf_imports_admin_delete" on public.shop_performance_imports;
create policy "shop_perf_imports_admin_delete"
  on public.shop_performance_imports for delete
  using (public.is_app_admin());

grant select, insert, update, delete on public.shop_performance_imports to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: 未紐付け行を seller に紐付け（既存 seller×期間行があればマージ）
-- ---------------------------------------------------------------------------
create or replace function public.link_shop_performance_to_seller(
  p_import_id uuid,
  p_seller_id uuid,
  p_alias_shop_name text,
  p_alias_normalized text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.shop_performance_imports%rowtype;
  v_existing public.shop_performance_imports%rowtype;
  v_new_key text;
  v_actor uuid := auth.uid();
begin
  if not public.is_app_admin() then
    raise exception 'forbidden: admin only';
  end if;

  if p_import_id is null or p_seller_id is null then
    raise exception 'import_id and seller_id are required';
  end if;

  if p_alias_normalized is null or length(trim(p_alias_normalized)) = 0 then
    raise exception 'alias_normalized is required';
  end if;

  select * into v_row
  from public.shop_performance_imports
  where id = p_import_id
  for update;

  if not found then
    raise exception 'import row not found';
  end if;

  if v_row.seller_id is not null then
    raise exception 'import row is already linked';
  end if;

  if not exists (select 1 from public.sellers where id = p_seller_id) then
    raise exception 'seller not found';
  end if;

  insert into public.seller_shop_aliases (
    seller_id,
    alias_shop_name,
    alias_normalized,
    created_by,
    updated_at
  )
  values (
    p_seller_id,
    coalesce(nullif(trim(p_alias_shop_name), ''), v_row.shop_name),
    p_alias_normalized,
    v_actor,
    now()
  )
  on conflict (alias_normalized) do update
    set
      seller_id = excluded.seller_id,
      alias_shop_name = excluded.alias_shop_name,
      updated_at = now();

  v_new_key := 'seller:' || p_seller_id::text;

  select * into v_existing
  from public.shop_performance_imports
  where identity_key = v_new_key
    and period_start = v_row.period_start
    and period_end = v_row.period_end
  for update;

  if found then
    update public.shop_performance_imports
    set
      shop_name = v_row.shop_name,
      shop_name_normalized = v_row.shop_name_normalized,
      shop_id = coalesce(v_row.shop_id, shop_performance_imports.shop_id),
      seller_id = p_seller_id,
      target_month = v_row.target_month,
      gmv_amount = v_row.gmv_amount,
      currency = v_row.currency,
      items_sold = v_row.items_sold,
      live_gmv_amount = v_row.live_gmv_amount,
      video_gmv_amount = v_row.video_gmv_amount,
      affiliate_gmv_amount = v_row.affiliate_gmv_amount,
      avg_customers = v_row.avg_customers,
      refund_amount = v_row.refund_amount,
      impressions = v_row.impressions,
      avg_visitors = v_row.avg_visitors,
      avg_conversion_rate_pct = v_row.avg_conversion_rate_pct,
      shop_ranking = v_row.shop_ranking,
      revenue_percentage = v_row.revenue_percentage,
      raw_row_json = v_row.raw_row_json,
      source = v_row.source,
      import_batch_id = v_row.import_batch_id,
      imported_by = coalesce(v_row.imported_by, imported_by),
      updated_at = now()
    where id = v_existing.id;

    delete from public.shop_performance_imports where id = v_row.id;

    return jsonb_build_object(
      'ok', true,
      'action', 'merged',
      'kept_import_id', v_existing.id,
      'deleted_import_id', v_row.id,
      'seller_id', p_seller_id
    );
  end if;

  update public.shop_performance_imports
  set
    identity_key = v_new_key,
    seller_id = p_seller_id,
    updated_at = now()
  where id = v_row.id;

  return jsonb_build_object(
    'ok', true,
    'action', 'linked',
    'kept_import_id', v_row.id,
    'seller_id', p_seller_id
  );
end;
$$;

revoke all on function public.link_shop_performance_to_seller(uuid, uuid, text, text)
  from public;
grant execute on function public.link_shop_performance_to_seller(uuid, uuid, text, text)
  to authenticated;

comment on function public.link_shop_performance_to_seller(uuid, uuid, text, text) is
  '未紐付けショップ実績を seller に紐付け。同期間の seller 行があればマージして未紐付け行を削除';
