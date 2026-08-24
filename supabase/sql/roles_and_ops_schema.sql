-- =============================================================================
-- 権限（admin / agency）と運用テーブル（CSV履歴・同期・通知）
-- Supabase SQL Editor に貼り付けて実行
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles.role
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists role text not null default 'agency';

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check check (role in ('admin', 'agency'));

comment on column public.profiles.role is 'admin=親管理者, agency=代理店ユーザー';

-- ---------------------------------------------------------------------------
-- 管理者判定（RLS 用）
-- ---------------------------------------------------------------------------
create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  )
  or lower(coalesce(
    (select trim(u.email::text) from auth.users u where u.id = auth.uid()),
    ''
  )) in (
    'duffy.hat@gmail.com'
  );
$$;

comment on function public.is_app_admin() is
  'profiles.role=admin または許可メール（auth.users）で親管理者判定。メール一覧は lib/db/admin-email-allowlist.ts と揃える';

-- ---------------------------------------------------------------------------
-- csv_import_logs
-- ---------------------------------------------------------------------------
create table if not exists public.csv_import_logs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies (id) on delete cascade,
  uploaded_by uuid not null references auth.users (id) on delete cascade,
  uploader_email text,
  target_month text not null,
  file_name text not null,
  success_count integer not null default 0,
  failed_count integer not null default 0,
  failure_reasons text,
  created_at timestamptz not null default now(),
  constraint csv_import_logs_month_format check (target_month ~ '^\d{4}-\d{2}$')
);

comment on table public.csv_import_logs is 'CSV / XLSX 取込履歴';

create index if not exists csv_import_logs_agency_created_idx
  on public.csv_import_logs (agency_id, created_at desc);

create index if not exists csv_import_logs_target_month_idx
  on public.csv_import_logs (target_month desc);

-- ---------------------------------------------------------------------------
-- sync_jobs（TikTok Shop API 同期の準備）
-- ---------------------------------------------------------------------------
create table if not exists public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  sync_type text not null,
  executed_at timestamptz,
  status text not null default 'pending',
  success_count integer not null default 0,
  failed_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  constraint sync_jobs_status_check check (
    status in ('pending', 'running', 'success', 'failed')
  )
);

comment on table public.sync_jobs is 'TikTok Shop API 同期ジョブ（将来用）';

create index if not exists sync_jobs_created_at_idx
  on public.sync_jobs (created_at desc);

-- ---------------------------------------------------------------------------
-- notification_logs（LINE 通知の準備）
-- ---------------------------------------------------------------------------
create table if not exists public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  destination text not null,
  body text not null,
  notification_type text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint notification_logs_status_check check (
    status in ('pending', 'sent', 'failed')
  )
);

comment on table public.notification_logs is '通知送信ログ（将来用）';

create index if not exists notification_logs_created_at_idx
  on public.notification_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: csv_import_logs
-- ---------------------------------------------------------------------------
alter table public.csv_import_logs enable row level security;

drop policy if exists "csv_import_logs_select_admin_or_agency" on public.csv_import_logs;
create policy "csv_import_logs_select_admin_or_agency"
  on public.csv_import_logs for select
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
  );

drop policy if exists "csv_import_logs_insert_agency" on public.csv_import_logs;
create policy "csv_import_logs_insert_agency"
  on public.csv_import_logs for insert
  with check (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
  );

-- ---------------------------------------------------------------------------
-- RLS: sync_jobs / notification_logs（親管理者のみ）
-- ---------------------------------------------------------------------------
alter table public.sync_jobs enable row level security;
alter table public.notification_logs enable row level security;

drop policy if exists "sync_jobs_admin_select" on public.sync_jobs;
create policy "sync_jobs_admin_select"
  on public.sync_jobs for select
  using (public.is_app_admin());

drop policy if exists "sync_jobs_admin_insert" on public.sync_jobs;
create policy "sync_jobs_admin_insert"
  on public.sync_jobs for insert
  with check (public.is_app_admin());

drop policy if exists "notification_logs_admin_select" on public.notification_logs;
create policy "notification_logs_admin_select"
  on public.notification_logs for select
  using (public.is_app_admin());

drop policy if exists "notification_logs_admin_insert" on public.notification_logs;
create policy "notification_logs_admin_insert"
  on public.notification_logs for insert
  with check (public.is_app_admin());

-- ---------------------------------------------------------------------------
-- 既存テーブル RLS を admin 閲覧対応に更新
-- ---------------------------------------------------------------------------
drop policy if exists "agencies_select_member" on public.agencies;
create policy "agencies_select_admin_or_member"
  on public.agencies for select
  using (
    public.is_app_admin()
    or id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
  );

drop policy if exists "creators_select_agency" on public.creators;
create policy "creators_select_admin_or_agency"
  on public.creators for select
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
  );

drop policy if exists "sales_imports_select_agency" on public.sales_imports;
create policy "sales_imports_select_admin_or_agency"
  on public.sales_imports for select
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
  );

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert on public.csv_import_logs to authenticated;
grant select, insert on public.sync_jobs to authenticated;
grant select, insert on public.notification_logs to authenticated;

-- 親管理者に昇格する例:
-- update public.profiles set role = 'admin' where id = 'YOUR_AUTH_USER_UUID';
