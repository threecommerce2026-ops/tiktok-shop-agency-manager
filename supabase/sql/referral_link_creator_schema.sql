-- =============================================================================
-- 紹介リンク経由クリエイター仮登録用カラム
-- 前提: referrer_portal_schema.sql 実行済み
-- =============================================================================

alter table public.creators
  add column if not exists line_name text;

alter table public.creators
  add column if not exists status text not null default 'assigned';

alter table public.creators
  add column if not exists source text;

update public.creators
set line_name = coalesce(nullif(trim(line_name), ''), nullif(trim(line_display_name), ''))
where line_name is null
  and line_display_name is not null;

update public.creators
set status = registration_status
where status is null
   or trim(status) = '';

alter table public.creators
  alter column tiktok_id drop not null;

alter table public.creators
  add column if not exists official_line_registered boolean not null default false;

comment on column public.creators.line_name is '紹介リンク経由で取得した LINE 名';
comment on column public.creators.status is '運用ステータス（pending=仮登録）';
comment on column public.creators.source is '登録経路（referral_link 等）';
comment on column public.creators.official_line_registered is '紹介リンク登録時に公式LINE登録済みと申告したか';
