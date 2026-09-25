-- =============================================================================
-- 支払管理（振込単位の支払明細）
-- =============================================================================
-- 非破壊方針:
--   ・既存テーブル / 既存カラム / 既存関数は変更・削除しない
--   ・追加するのは CREATE TABLE / CREATE INDEX / CREATE POLICY / GRANT のみ
--
-- 何のための層か:
--   報酬額そのものは既存 Finance Engine が agency_reward_items /
--   referral_reward_items に確定させている。ここはその明細を
--   「1回の銀行振込」にまとめて、振込前後の状態を管理するだけの層。
--   報酬の計算式はここには無い。
--
-- agency_payouts / referral_payouts との違い:
--   あちらは「対象月時点の年初来累積スナップショット」で、
--   行を単純合計すると重複する（振込単位ではない）。
--   payment_batches は1行＝1回の振込。合計しても二重計上しない。
--
-- 支払状態:
--   draft      支払明細を作成した（金額確定・対象明細を占有済み）
--   approved   振込内容を承認した（振込先スナップショット確定・CSV出力可）
--   processing 銀行へ送信済み・結果待ち
--   paid       振込完了を登録した（ここで初めて reward item が支払済みになる）
--   failed     振込失敗（占有を解放して未払いへ戻す）
--   cancelled  取消（占有を解放して未払いへ戻す）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 支払明細（1行＝1支払先への1回の振込）
-- -----------------------------------------------------------------------------
create table if not exists public.payment_batches (
  id uuid primary key default gen_random_uuid(),

  -- 支払先。代理店か紹介者のどちらか一方だけが入る
  payee_kind text not null,
  agency_id uuid references public.agencies(id) on delete restrict,
  referrer_id uuid references public.referrers(id) on delete restrict,

  -- 対象期間（YYYY-MM）。暦年をまたいでもよい
  period_start_month text not null,
  period_end_month text not null,

  -- 作成時点で確定させる金額。以後 reward item を再集計しても変わらない
  item_count integer not null default 0,
  gross_amount numeric not null default 0,
  payment_amount numeric not null default 0,

  status text not null default 'draft',

  -- 振込先スナップショット（承認時に支払先マスタから複写して固定する）
  bank_name text,
  bank_code text,
  bank_branch_name text,
  bank_branch_code text,
  bank_account_type text,
  bank_account_number text,
  bank_account_holder text,

  memo text,
  failure_reason text,

  created_by uuid,
  created_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  paid_by uuid,
  paid_at timestamptz,
  -- 実際に銀行で振り込んだ日（paid_at は登録操作の時刻）
  paid_on date,
  updated_at timestamptz not null default now(),

  constraint payment_batches_payee_kind_check
    check (payee_kind in ('agency', 'referrer')),

  constraint payment_batches_status_check
    check (status in ('draft', 'approved', 'processing', 'paid', 'failed', 'cancelled')),

  constraint payment_batches_month_format_check
    check (
      period_start_month ~ '^\d{4}-\d{2}$'
      and period_end_month ~ '^\d{4}-\d{2}$'
      and period_end_month >= period_start_month
    ),

  -- 支払先は排他。両方 null / 両方設定 を弾く
  constraint payment_batches_payee_exclusive_check
    check (
      (payee_kind = 'agency' and agency_id is not null and referrer_id is null)
      or (payee_kind = 'referrer' and referrer_id is not null and agency_id is null)
    ),

  constraint payment_batches_amount_check
    check (item_count >= 0 and gross_amount >= 0 and payment_amount >= 0)
);

comment on table public.payment_batches is
  '支払明細。1行＝1支払先への1回の銀行振込。報酬計算は行わず、既存の報酬明細を束ねるだけ。';
comment on column public.payment_batches.payment_amount is
  '今回の振込額。作成時に確定し、以後の再集計では変化しない。';
comment on column public.payment_batches.bank_account_number is
  '承認時に複写した口座番号。一覧・明細画面へ全文を出さないこと（CSV生成時のみ参照）。';
comment on column public.payment_batches.paid_on is
  '実際に銀行で振り込んだ日。paid_at（登録操作の時刻）とは別。';

create index if not exists payment_batches_agency_idx
  on public.payment_batches (agency_id, status);

create index if not exists payment_batches_referrer_idx
  on public.payment_batches (referrer_id, status);

create index if not exists payment_batches_status_idx
  on public.payment_batches (status, created_at desc);

create index if not exists payment_batches_period_idx
  on public.payment_batches (period_end_month desc);

-- -----------------------------------------------------------------------------
-- 2. 監査ログ（誰がいつ何をしたか）
-- -----------------------------------------------------------------------------
create table if not exists public.payment_batch_audit_logs (
  id uuid primary key default gen_random_uuid(),

  batch_id uuid not null
    references public.payment_batches(id) on delete cascade,

  action text not null,
  from_status text,
  to_status text,

  item_count integer,
  amount numeric,

  actor_id uuid,
  actor_email text,

  note text,
  created_at timestamptz not null default now(),

  constraint payment_batch_audit_logs_action_check
    check (action in (
      'created',
      'approved',
      'csv_exported',
      'processing',
      'paid',
      'failed',
      'cancelled'
    ))
);

comment on table public.payment_batch_audit_logs is
  '支払明細の操作履歴。作成・承認・CSV出力・振込完了・失敗・取消を記録する。';

create index if not exists payment_batch_audit_logs_batch_idx
  on public.payment_batch_audit_logs (batch_id, created_at desc);

create index if not exists payment_batch_audit_logs_action_idx
  on public.payment_batch_audit_logs (action, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. RLS（親管理者のみ）
-- -----------------------------------------------------------------------------
-- 代理店ユーザーからは支払情報・振込先情報を一切読めないようにする。
-- agency_reward_items のような「自社分は見える」ポリシーは付けない。
alter table public.payment_batches enable row level security;
alter table public.payment_batch_audit_logs enable row level security;

drop policy if exists "payment_batches_admin_all" on public.payment_batches;
create policy "payment_batches_admin_all"
  on public.payment_batches for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "payment_batch_audit_logs_admin_all"
  on public.payment_batch_audit_logs;
create policy "payment_batch_audit_logs_admin_all"
  on public.payment_batch_audit_logs for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

-- RLS が効くので grant 自体は authenticated に出してよい（管理者以外は0件）
grant select, insert, update, delete on public.payment_batches to authenticated;
grant select, insert on public.payment_batch_audit_logs to authenticated;

grant all on public.payment_batches to service_role;
grant all on public.payment_batch_audit_logs to service_role;
