-- seller_import_histories (seller CSV/Excel import batch history)
create extension if not exists "pgcrypto";

create table if not exists public.seller_import_histories (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  total_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  error_count integer not null default 0,
  imported_by text,
  created_at timestamptz not null default now(),
  raw_result jsonb
);

comment on table public.seller_import_histories is 'セラー CSV/Excel 取込バッチ履歴';

create index if not exists seller_import_histories_created_at_idx
  on public.seller_import_histories (created_at desc);

alter table public.seller_import_histories enable row level security;

drop policy if exists "seller_import_histories_admin_select" on public.seller_import_histories;
create policy "seller_import_histories_admin_select"
  on public.seller_import_histories for select
  using (public.is_app_admin());

drop policy if exists "seller_import_histories_admin_insert" on public.seller_import_histories;
create policy "seller_import_histories_admin_insert"
  on public.seller_import_histories for insert
  with check (public.is_app_admin());

drop policy if exists "seller_import_histories_admin_update" on public.seller_import_histories;
create policy "seller_import_histories_admin_update"
  on public.seller_import_histories for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "seller_import_histories_admin_delete" on public.seller_import_histories;
create policy "seller_import_histories_admin_delete"
  on public.seller_import_histories for delete
  using (public.is_app_admin());

grant select, insert, update, delete on public.seller_import_histories to authenticated;
