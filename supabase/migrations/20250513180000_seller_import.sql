-- sellers import columns + seller_import_logs
alter table public.sellers
  add column if not exists source_created_at timestamptz;

alter table public.sellers
  add column if not exists import_source text not null default 'manual';

alter table public.sellers
  add column if not exists raw_import_json jsonb;

comment on column public.sellers.source_created_at is 'フォーム/Excel の創建時間など';
comment on column public.sellers.import_source is 'manual | excel | csv';
comment on column public.sellers.raw_import_json is '直近の取込1行分の生データ';

create table if not exists public.seller_import_logs (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  source_type text not null default 'excel',
  total_rows integer not null default 0,
  new_count integer not null default 0,
  update_count integer not null default 0,
  error_count integer not null default 0,
  errors_summary jsonb,
  imported_by uuid references auth.users (id) on delete set null,
  imported_by_email text,
  created_at timestamptz not null default now(),
  constraint seller_import_logs_source_type_check check (source_type in ('excel', 'csv'))
);

comment on table public.seller_import_logs is 'セラー Excel/CSV 取込履歴（親管理者のみ）';

create index if not exists seller_import_logs_created_at_idx
  on public.seller_import_logs (created_at desc);

alter table public.seller_import_logs enable row level security;

drop policy if exists "seller_import_logs_admin_select" on public.seller_import_logs;
create policy "seller_import_logs_admin_select"
  on public.seller_import_logs for select
  using (public.is_app_admin());

drop policy if exists "seller_import_logs_admin_insert" on public.seller_import_logs;
create policy "seller_import_logs_admin_insert"
  on public.seller_import_logs for insert
  with check (public.is_app_admin());

drop policy if exists "seller_import_logs_admin_update" on public.seller_import_logs;
create policy "seller_import_logs_admin_update"
  on public.seller_import_logs for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "seller_import_logs_admin_delete" on public.seller_import_logs;
create policy "seller_import_logs_admin_delete"
  on public.seller_import_logs for delete
  using (public.is_app_admin());

grant select, insert, update, delete on public.seller_import_logs to authenticated;
