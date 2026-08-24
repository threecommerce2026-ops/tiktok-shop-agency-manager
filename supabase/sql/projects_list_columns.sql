-- =============================================================================
-- projects テーブル拡張（一覧・案件カード用）
-- Supabase SQL Editor に貼り付けて実行（既存 DB 向け・データは保持）
-- =============================================================================

alter table public.projects
  add column if not exists reward_rate numeric(6, 3);

comment on column public.projects.reward_rate is '報酬率（例: 12.5 = 12.5%）';

alter table public.projects
  add column if not exists project_kind text not null default 'video';

comment on column public.projects.project_kind is 'live | video | store';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_project_kind_check'
  ) then
    alter table public.projects
      add constraint projects_project_kind_check
      check (project_kind in ('live', 'video', 'store'));
  end if;
end $$;

create index if not exists projects_project_kind_idx on public.projects (project_kind);

-- ジャンル・サムネイル・投稿期限
alter table public.projects
  add column if not exists genre text;

comment on column public.projects.genre is 'ジャンル（美容・食品など）';

alter table public.projects
  add column if not exists thumbnail_url text;

comment on column public.projects.thumbnail_url is 'サムネイル画像 URL';

alter table public.projects
  add column if not exists deadline_at timestamptz;

comment on column public.projects.deadline_at is '投稿期限';

create index if not exists projects_deadline_at_idx on public.projects (deadline_at);
