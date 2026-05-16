-- TikTok Shop Agency Manager: core tables + RLS
-- Supabase SQL Editor または `supabase db push` で適用してください。

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 案件 (projects)
-- ---------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
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
comment on column public.projects.genre is 'ジャンル';
comment on column public.projects.thumbnail_url is 'サムネイル URL';
comment on column public.projects.deadline_at is '投稿期限';
create index projects_user_id_idx on public.projects (user_id);
create index projects_project_kind_idx on public.projects (project_kind);

-- ---------------------------------------------------------------------------
-- クリエイター (creators)
-- ---------------------------------------------------------------------------
create table public.creators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null,
  email text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.creators is 'クリエイター';
create index creators_user_id_idx on public.creators (user_id);

-- ---------------------------------------------------------------------------
-- 紹介者 (referrers)
-- ---------------------------------------------------------------------------
create table public.referrers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  contact_email text,
  commission_rate numeric(5, 2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.referrers is '紹介者';
create index referrers_user_id_idx on public.referrers (user_id);

-- ---------------------------------------------------------------------------
-- 売上 (sales)
-- ---------------------------------------------------------------------------
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  amount numeric(14, 2) not null,
  currency text not null default 'JPY',
  sold_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now()
);

comment on table public.sales is '売上';
create index sales_user_id_idx on public.sales (user_id);
create index sales_project_id_idx on public.sales (project_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;
alter table public.creators enable row level security;
alter table public.referrers enable row level security;
alter table public.sales enable row level security;

create policy "projects_select_own" on public.projects for select using (auth.uid() = user_id);
create policy "projects_insert_own" on public.projects for insert with check (auth.uid() = user_id);
create policy "projects_update_own" on public.projects for update using (auth.uid() = user_id);
create policy "projects_delete_own" on public.projects for delete using (auth.uid() = user_id);

create policy "creators_select_own" on public.creators for select using (auth.uid() = user_id);
create policy "creators_insert_own" on public.creators for insert with check (auth.uid() = user_id);
create policy "creators_update_own" on public.creators for update using (auth.uid() = user_id);
create policy "creators_delete_own" on public.creators for delete using (auth.uid() = user_id);

create policy "referrers_select_own" on public.referrers for select using (auth.uid() = user_id);
create policy "referrers_insert_own" on public.referrers for insert with check (auth.uid() = user_id);
create policy "referrers_update_own" on public.referrers for update using (auth.uid() = user_id);
create policy "referrers_delete_own" on public.referrers for delete using (auth.uid() = user_id);

create policy "sales_select_own" on public.sales for select using (auth.uid() = user_id);
create policy "sales_insert_own" on public.sales for insert with check (auth.uid() = user_id);
create policy "sales_update_own" on public.sales for update using (auth.uid() = user_id);
create policy "sales_delete_own" on public.sales for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Grants (authenticated のみアプリから利用)
-- ---------------------------------------------------------------------------
grant usage on schema public to postgres, anon, authenticated, service_role;

grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.creators to authenticated;
grant select, insert, update, delete on public.referrers to authenticated;
grant select, insert, update, delete on public.sales to authenticated;
