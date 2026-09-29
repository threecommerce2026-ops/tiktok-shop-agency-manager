-- =============================================================================
-- Creator referral logs
-- クリエイターの紹介者・適用期間の変更履歴
-- =============================================================================
/*
  ■ なぜ必要か
  所属側には creator_monthly_agency_assignment_logs があり
  「どの月の所属を、誰が、どう変えたか」を追える。
  紹介者側は creator_master_change_logs に「誰に変えたか」しか残らず、
  適用開始月・変更前の期間・影響範囲が記録されていなかった。

  紹介報酬は creator_referrals の期間で誰に帰属するかが決まる。
  期間の変更は金額の変更と同じ重みがあるので、所属側と同じ粒度で残す。

  ■ 期間は前後を構造化して持つ
  「何月から何月までだった関係を、何月からどう変更したか」を
  後から復元できるようにする。文字列や JSON へ押し込まない。

      previous_referrer_id / previous_start_month / previous_end_month
      referrer_id          / start_month          / end_month

  紹介者を変えずに開始月だけ直す場合もあるため、
  previous_referrer_id と referrer_id が同じ行も普通に出る。

  ■ 監査ログなので更新・削除させない
  既存の creator_assignment_logs と同じく select / insert だけを許可する。
*/

create extension if not exists "pgcrypto";

create table if not exists public.creator_referral_logs (
  id uuid primary key default gen_random_uuid(),

  creator_id uuid not null
    references public.creators (id)
    on delete cascade,

  /*
    何をしたか。
      create              紹介者を新しく紐付けた
      reassign            別の紹介者へ変更した
      change_start_month  同じ紹介者のまま適用開始月を直した
      unlink              紹介者を外した
  */
  action text not null,

  previous_referrer_id uuid
    references public.referrers (id)
    on delete set null,

  previous_start_month text,

  previous_end_month text,

  referrer_id uuid
    references public.referrers (id)
    on delete set null,

  start_month text,

  end_month text,

  /*
    この変更で紹介報酬の計算が変わりうる月の範囲。
    過去へ遡る変更かどうかを一覧で判断できるようにする。
  */
  affected_start_month text,

  affected_end_month text,

  note text,

  changed_by uuid not null
    references auth.users (id)
    on delete restrict,

  changed_by_email text,

  created_at timestamptz not null default now(),

  constraint creator_referral_logs_action_check
    check (action in ('create', 'reassign', 'change_start_month', 'unlink')),

  constraint creator_referral_logs_previous_start_month_check
    check (previous_start_month is null or previous_start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint creator_referral_logs_previous_end_month_check
    check (previous_end_month is null or previous_end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint creator_referral_logs_start_month_check
    check (start_month is null or start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint creator_referral_logs_end_month_check
    check (end_month is null or end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint creator_referral_logs_affected_start_month_check
    check (affected_start_month is null or affected_start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint creator_referral_logs_affected_end_month_check
    check (affected_end_month is null or affected_end_month ~ '^\d{4}-(0[1-9]|1[0-2])$')
);

comment on table public.creator_referral_logs is
  'クリエイターの紹介者・適用期間の変更履歴。紹介報酬の帰属が変わる操作を残す。';

comment on column public.creator_referral_logs.action is
  'create=新規紐付け / reassign=別の紹介者へ変更 / change_start_month=開始月の修正 / unlink=紹介者を外す';
comment on column public.creator_referral_logs.previous_referrer_id is
  '変更前の紹介者。新規紐付けなら NULL';
comment on column public.creator_referral_logs.previous_start_month is
  '変更前の適用開始月';
comment on column public.creator_referral_logs.previous_end_month is
  '変更前の適用終了月。継続中だった場合は NULL';
comment on column public.creator_referral_logs.referrer_id is
  '変更後の紹介者。紹介者を外した場合は NULL';
comment on column public.creator_referral_logs.start_month is
  '変更後の適用開始月';
comment on column public.creator_referral_logs.end_month is
  '変更後の適用終了月。継続中は NULL';
comment on column public.creator_referral_logs.affected_start_month is
  '紹介報酬の計算が変わりうる範囲の開始月。過去へ遡る変更かを判断するために残す';
comment on column public.creator_referral_logs.affected_end_month is
  '同じく範囲の終了月';
comment on column public.creator_referral_logs.changed_by is
  '変更を実行した auth.users.id';
comment on column public.creator_referral_logs.changed_by_email is
  '変更実行者のメールアドレス（監査用スナップショット）';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index if not exists creator_referral_logs_creator_id_idx
  on public.creator_referral_logs (creator_id, created_at desc);

create index if not exists creator_referral_logs_created_at_idx
  on public.creator_referral_logs (created_at desc);

create index if not exists creator_referral_logs_referrer_id_idx
  on public.creator_referral_logs (referrer_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
/*
  管理者だけが読み書きできる。クリエイターや紹介者が自分の履歴を
  書き換えられないよう、update / delete は誰にも許可しない。
*/

alter table public.creator_referral_logs enable row level security;

drop policy if exists "creator_referral_logs_admin_select"
  on public.creator_referral_logs;

create policy "creator_referral_logs_admin_select"
  on public.creator_referral_logs
  for select
  to authenticated
  using (public.is_app_admin());

drop policy if exists "creator_referral_logs_admin_insert"
  on public.creator_referral_logs;

create policy "creator_referral_logs_admin_insert"
  on public.creator_referral_logs
  for insert
  to authenticated
  with check (
    public.is_app_admin()
    and changed_by = auth.uid()
  );

-- 監査ログなので UPDATE / DELETE は許可しない

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select, insert
  on public.creator_referral_logs
  to authenticated;

grant all
  on public.creator_referral_logs
  to service_role;
