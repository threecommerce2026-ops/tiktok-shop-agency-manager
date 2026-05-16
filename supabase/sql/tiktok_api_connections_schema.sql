-- =============================================================================
-- TikTok Shop API 接続設定（tiktok_api_connections）
-- Supabase SQL Editor に貼り付けて実行
-- 前提: public.is_app_admin() が定義済み（roles_and_ops_schema.sql）
-- =============================================================================

create extension if not exists "pgcrypto";

create or replace function public.set_tiktok_api_connections_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.tiktok_api_connections (
  id uuid primary key default gen_random_uuid(),
  app_key text not null,
  app_secret text not null,
  access_token text not null,
  refresh_token text,
  shop_cipher text,
  shop_id text not null,
  token_expired_at timestamptz,
  is_active boolean not null default false,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tiktok_api_connections is 'TikTok Shop API 接続情報（複数ショップ対応）';
comment on column public.tiktok_api_connections.shop_cipher is 'TikTok Shop API shop_cipher';
comment on column public.tiktok_api_connections.is_active is '同期対象として有効な接続か';
comment on column public.tiktok_api_connections.last_synced_at is '最後に注文同期した日時';

create index if not exists tiktok_api_connections_shop_id_idx
  on public.tiktok_api_connections (shop_id);

create index if not exists tiktok_api_connections_is_active_idx
  on public.tiktok_api_connections (is_active);

create index if not exists tiktok_api_connections_updated_at_idx
  on public.tiktok_api_connections (updated_at desc);

drop trigger if exists tiktok_api_connections_set_updated_at on public.tiktok_api_connections;
create trigger tiktok_api_connections_set_updated_at
  before update on public.tiktok_api_connections
  for each row
  execute function public.set_tiktok_api_connections_updated_at();

alter table public.tiktok_api_connections enable row level security;

drop policy if exists "tiktok_api_connections_admin_select" on public.tiktok_api_connections;
create policy "tiktok_api_connections_admin_select"
  on public.tiktok_api_connections for select
  using (public.is_app_admin());

drop policy if exists "tiktok_api_connections_admin_insert" on public.tiktok_api_connections;
create policy "tiktok_api_connections_admin_insert"
  on public.tiktok_api_connections for insert
  with check (public.is_app_admin());

drop policy if exists "tiktok_api_connections_admin_update" on public.tiktok_api_connections;
create policy "tiktok_api_connections_admin_update"
  on public.tiktok_api_connections for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "tiktok_api_connections_admin_delete" on public.tiktok_api_connections;
create policy "tiktok_api_connections_admin_delete"
  on public.tiktok_api_connections for delete
  using (public.is_app_admin());

grant select, insert, update, delete on public.tiktok_api_connections to authenticated;

drop policy if exists "sync_jobs_admin_update" on public.sync_jobs;
create policy "sync_jobs_admin_update"
  on public.sync_jobs for update
  using (public.is_app_admin())
  with check (public.is_app_admin());

grant update on public.sync_jobs to authenticated;
