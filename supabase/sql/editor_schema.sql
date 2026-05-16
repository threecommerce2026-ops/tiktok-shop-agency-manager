-- =============================================================================
-- TikTok Shop Agency Manager — Supabase SQL Editor 用（全文コピー＆実行）
-- =============================================================================
-- 内容: auth.users 連携（user_id） / 外部キー / RLS / updated_at 自動更新
--
-- ⚠️ 注意: 下記 DROP で public.sales, projects, creators, referrers のデータが
--    消えます。本番で既存データがある場合は DROP ブロックをコメントアウトし、
--    ALTER のみ手動で行ってください。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. クリーンアップ（作り直し用）※ テーブル DROP でトリガーも消えます
-- ---------------------------------------------------------------------------
drop table if exists public.sales cascade;
drop table if exists public.creators cascade;
drop table if exists public.referrers cascade;
drop table if exists public.projects cascade;

drop function if exists public.tsam_handle_updated_at() cascade;

-- ---------------------------------------------------------------------------
-- 1. 拡張
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 2. updated_at 自動更新（BEFORE UPDATE）
-- ---------------------------------------------------------------------------
create or replace function public.tsam_handle_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.tsam_handle_updated_at() is
  'UPDATE 時に updated_at を now() に更新（TSAM）';

-- ---------------------------------------------------------------------------
-- 3. テーブル（user_id → auth.users, 外部キー）
-- ---------------------------------------------------------------------------

-- 案件
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  title text not null,
  description text,
  category text,
  genre text,
  status text not null default 'draft',
  reward_rate numeric(6, 3),
  project_kind text not null default 'video'
    constraint projects_project_kind_check check (project_kind in ('live', 'video', 'store')),
  thumbnail_url text,
  deadline_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.projects is '案件';
comment on column public.projects.reward_rate is '報酬率（例: 12.5 = 12.5%）';
comment on column public.projects.project_kind is 'ライブ / 動画 / 店舗';
comment on column public.projects.genre is 'ジャンル（美容・食品など）';
comment on column public.projects.thumbnail_url is 'サムネイル画像 URL';
comment on column public.projects.deadline_at is '投稿期限';

create index if not exists projects_user_id_idx on public.projects (user_id);
create index if not exists projects_project_kind_idx on public.projects (project_kind);

-- クリエイター
create table public.creators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  display_name text not null,
  email text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.creators is 'クリエイター';

create index if not exists creators_user_id_idx on public.creators (user_id);

-- 紹介者
create table public.referrers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  name text not null,
  contact_email text,
  commission_rate numeric(5, 2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.referrers is '紹介者';

create index if not exists referrers_user_id_idx on public.referrers (user_id);

-- 売上（案件への外部キー + auth 連携）
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  amount numeric(14, 2) not null,
  currency text not null default 'JPY',
  sold_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sales is '売上';

create index if not exists sales_user_id_idx on public.sales (user_id);
create index if not exists sales_project_id_idx on public.sales (project_id);

-- ---------------------------------------------------------------------------
-- 4. updated_at トリガー
-- ---------------------------------------------------------------------------
create trigger trg_projects_updated_at
  before update on public.projects
  for each row
  execute procedure public.tsam_handle_updated_at();

create trigger trg_creators_updated_at
  before update on public.creators
  for each row
  execute procedure public.tsam_handle_updated_at();

create trigger trg_referrers_updated_at
  before update on public.referrers
  for each row
  execute procedure public.tsam_handle_updated_at();

create trigger trg_sales_updated_at
  before update on public.sales
  for each row
  execute procedure public.tsam_handle_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Row Level Security（認証ユーザー = user_id の行のみ）
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;
alter table public.creators enable row level security;
alter table public.referrers enable row level security;
alter table public.sales enable row level security;

-- projects
create policy "projects_select_own"
  on public.projects for select
  using (auth.uid() = user_id);

create policy "projects_insert_own"
  on public.projects for insert
  with check (auth.uid() = user_id);

create policy "projects_update_own"
  on public.projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "projects_delete_own"
  on public.projects for delete
  using (auth.uid() = user_id);

-- creators
create policy "creators_select_own"
  on public.creators for select
  using (auth.uid() = user_id);

create policy "creators_insert_own"
  on public.creators for insert
  with check (auth.uid() = user_id);

create policy "creators_update_own"
  on public.creators for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "creators_delete_own"
  on public.creators for delete
  using (auth.uid() = user_id);

-- referrers
create policy "referrers_select_own"
  on public.referrers for select
  using (auth.uid() = user_id);

create policy "referrers_insert_own"
  on public.referrers for insert
  with check (auth.uid() = user_id);

create policy "referrers_update_own"
  on public.referrers for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "referrers_delete_own"
  on public.referrers for delete
  using (auth.uid() = user_id);

-- sales（参照先 project は別ユーザーのものを選べないよう WITH CHECK）
create policy "sales_select_own"
  on public.sales for select
  using (auth.uid() = user_id);

create policy "sales_insert_own"
  on public.sales for insert
  with check (
    auth.uid() = user_id
    and (
      project_id is null
      or exists (
        select 1 from public.projects p
        where p.id = project_id and p.user_id = auth.uid()
      )
    )
  );

create policy "sales_update_own"
  on public.sales for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      project_id is null
      or exists (
        select 1 from public.projects p
        where p.id = project_id and p.user_id = auth.uid()
      )
    )
  );

create policy "sales_delete_own"
  on public.sales for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 6. 権限（アプリは anon key + ログインユーザー = authenticated）
-- ---------------------------------------------------------------------------
grant usage on schema public to postgres, anon, authenticated, service_role;

grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.creators to authenticated;
grant select, insert, update, delete on public.referrers to authenticated;
grant select, insert, update, delete on public.sales to authenticated;

-- service_role（ダッシュボードの管理者 API 等）は従来どおり全件アクセス可（RLS バイパス）
