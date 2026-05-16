-- クリエイター振り分け運用（未振り分け・デフォルト分配率・変更履歴）
-- Supabase SQL Editor で実行

-- 未振り分けを表現するため agency_id を NULL 許可
alter table public.creators
  alter column agency_id drop not null;

comment on column public.creators.agency_id is '所属代理店。NULL は未振り分け';

-- 未振り分けクリエイターは TikTok ID を一意に
create unique index if not exists creators_tiktok_unassigned_unique
  on public.creators (tiktok_id)
  where agency_id is null;

-- 代理店デフォルト分配率
alter table public.agencies
  add column if not exists default_commission_rate numeric(10, 4) not null default 5;

comment on column public.agencies.default_commission_rate is '新規振り分け時のデフォルト分配率（%）';

-- 振り分け変更履歴
create table if not exists public.creator_assignment_logs (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators (id) on delete cascade,
  from_agency_id uuid references public.agencies (id) on delete set null,
  to_agency_id uuid references public.agencies (id) on delete set null,
  from_commission_rate numeric(10, 4),
  to_commission_rate numeric(10, 4) not null,
  changed_by uuid not null references auth.users (id) on delete cascade,
  changed_by_email text,
  created_at timestamptz not null default now()
);

comment on table public.creator_assignment_logs is 'クリエイター振り分け・分配率の変更履歴';

create index if not exists creator_assignment_logs_creator_created_idx
  on public.creator_assignment_logs (creator_id, created_at desc);

create index if not exists creator_assignment_logs_created_idx
  on public.creator_assignment_logs (created_at desc);

alter table public.creator_assignment_logs enable row level security;

drop policy if exists "creator_assignment_logs_admin_select" on public.creator_assignment_logs;
create policy "creator_assignment_logs_admin_select"
  on public.creator_assignment_logs for select
  using (public.is_app_admin());

drop policy if exists "creator_assignment_logs_admin_insert" on public.creator_assignment_logs;
create policy "creator_assignment_logs_admin_insert"
  on public.creator_assignment_logs for insert
  with check (public.is_app_admin());

grant select, insert on public.creator_assignment_logs to authenticated;

-- 親管理者は全クリエイターを更新可能
drop policy if exists "creators_update_agency" on public.creators;
drop policy if exists "creators_update_admin_or_agency" on public.creators;
create policy "creators_update_admin_or_agency"
  on public.creators for update
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
  );

-- 親管理者は未振り分けクリエイターを作成可能
drop policy if exists "creators_insert_agency" on public.creators;
create policy "creators_insert_admin_or_agency"
  on public.creators for insert
  with check (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
  );
