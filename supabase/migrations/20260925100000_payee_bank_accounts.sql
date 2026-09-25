-- =============================================================================
-- 支払先（代理店・紹介者）の振込先口座情報
-- =============================================================================
-- 非破壊方針:
--   ・既存テーブル / 既存カラム / 既存関数は変更・削除しない
--   ・追加するのは ADD COLUMN と権限調整のみ
--   ・既存行の値は1件も更新しない（全カラム nullable）
--
-- 背景:
--   代理店へ振り込むための口座情報がどこにも存在しなかった
--   （agencies は id / name / created_at / default_commission_rate /
--     is_active / is_in_house のみ）。
--   紹介者は referrers に bank_* が既にあるため、その命名に揃える。
--   不足しているのは金融機関コード・支店コードの2つだけ。
--
-- 命名は referrers の既存カラムを正とする:
--   bank_name / bank_branch_name / bank_account_type /
--   bank_account_number / bank_account_holder
--   ここに bank_code / bank_branch_code を足す。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. agencies へ振込先を追加
-- -----------------------------------------------------------------------------
alter table public.agencies add column if not exists bank_name text;
alter table public.agencies add column if not exists bank_code text;
alter table public.agencies add column if not exists bank_branch_name text;
alter table public.agencies add column if not exists bank_branch_code text;
alter table public.agencies add column if not exists bank_account_type text;
alter table public.agencies add column if not exists bank_account_number text;
alter table public.agencies add column if not exists bank_account_holder text;

comment on column public.agencies.bank_name is '振込先金融機関名';
comment on column public.agencies.bank_code is '金融機関コード（4桁）。振込CSVに必要';
comment on column public.agencies.bank_branch_name is '支店名';
comment on column public.agencies.bank_branch_code is '支店コード（3桁）。振込CSVに必要';
comment on column public.agencies.bank_account_type is '口座種別（普通 / 当座）';
comment on column public.agencies.bank_account_number is '口座番号。管理画面へ全文を表示しないこと';
comment on column public.agencies.bank_account_holder is '口座名義（カナ）';

-- -----------------------------------------------------------------------------
-- 2. referrers へ不足分のみ追加
-- -----------------------------------------------------------------------------
-- 既存の bank_name / bank_branch_name / bank_account_type /
-- bank_account_number / bank_account_holder はそのまま使う（重複追加しない）。
alter table public.referrers add column if not exists bank_code text;
alter table public.referrers add column if not exists bank_branch_code text;

comment on column public.referrers.bank_code is '金融機関コード（4桁）。振込CSVに必要';
comment on column public.referrers.bank_branch_code is '支店コード（3桁）。振込CSVに必要';

-- -----------------------------------------------------------------------------
-- 3. 代理店ユーザーから銀行情報を隠す（列単位権限）
-- -----------------------------------------------------------------------------
-- referrers は RLS（referrers_admin_all / is_app_admin()）で
-- 既に管理者以外から完全に遮断されているため追加対応は不要。
--
-- agencies は RLS が無効で、authenticated にテーブル単位の SELECT / UPDATE が
-- 付いている。PostgreSQL ではテーブル単位の SELECT があると全列が見えるため、
-- RLS を足しても銀行列は隠せない（RLS は行単位であって列単位ではない）。
-- ここではテーブル単位の権限を外し、銀行列以外だけを列単位で付け直す。
--
-- ■ 意図的な副作用
--   今後 agencies に列を追加しても authenticated からは見えない。
--   見せる必要がある列は、そのときに明示的に grant する。
--   （気付かないうちに機微な列が公開されるより安全側に倒している）
--
-- ■ 既存コードへの影響が無いことは確認済み
--   agencies を select("*") している箇所は無く、
--   参照は id / name / is_active / is_in_house / default_commission_rate に限られる。
--   書き込みは name / is_active のみ。
--   管理画面の銀行情報の読み書きはサービスロール経由で行うため権限の影響を受けない。
revoke select, update on public.agencies from authenticated;

grant select (
  id,
  name,
  created_at,
  default_commission_rate,
  is_active,
  is_in_house
) on public.agencies to authenticated;

grant update (
  name,
  default_commission_rate,
  is_active,
  is_in_house
) on public.agencies to authenticated;

-- INSERT / DELETE は従来どおり（銀行情報を読めないので漏洩経路にならない）。
grant all on public.agencies to service_role;
