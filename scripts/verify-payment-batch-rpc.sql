-- =============================================================================
-- 支払明細 RPC の動作検証
-- =============================================================================
-- ■ 本番DBでは絶対に実行しないこと
--   実データを占有・支払済みにしてしまう。
--   使い捨ての空DBに対してのみ実行する。
--
-- 手順:
--   1) 使い捨ての PostgreSQL を起動する
--   2) scripts/stub-schema-for-payment-test.sql を流す（本番スキーマの最小再現）
--   3) supabase/migrations/20260925*.sql を順に流す
--   4) このファイルを流す
--
--   psql -d <throwaway> -v ON_ERROR_STOP=1 -f scripts/verify-payment-batch-rpc.sql
--
-- 検証するのは「SQL でしか確認できないこと」だけ:
--   占有の排他 / 状態遷移 / 支払済みの保護 / 件数・金額の一致検証。
--   金額の計算式は Finance Engine 側のテストが担当する。
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

create temp table test_results (
  seq serial,
  name text,
  ok boolean,
  detail text
);

create or replace function pg_temp.expect(p_name text, p_ok boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into test_results (name, ok, detail) values (p_name, p_ok, p_detail);
end;
$$;

-- 例外が起きることを期待する
create or replace function pg_temp.expect_error(p_name text, p_sql text, p_fragment text)
returns void language plpgsql as $$
declare
  v_msg text;
begin
  execute p_sql;
  insert into test_results (name, ok, detail)
    values (p_name, false, '例外が発生しませんでした');
exception when others then
  v_msg := SQLERRM;
  insert into test_results (name, ok, detail)
    values (p_name, position(p_fragment in v_msg) > 0, v_msg);
end;
$$;

-- -----------------------------------------------------------------------------
-- セットアップ
-- -----------------------------------------------------------------------------
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test');

set test.uid = '00000000-0000-0000-0000-0000000000a1';
set test.is_admin = 'true';

-- 代理店A: 振込先完備
insert into public.agencies (id, name, is_in_house, bank_name, bank_code,
  bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder)
values ('00000000-0000-0000-0000-00000000a001', 'TEST代理店A', false,
  'テスト銀行', '0001', 'テスト支店', '001', '普通', '1234567', 'テストダイリテンエー');

-- 代理店B: 振込先なし
insert into public.agencies (id, name, is_in_house)
values ('00000000-0000-0000-0000-00000000a002', 'TEST代理店B', false);

-- 代理店C: 自社（振込先は完備）
insert into public.agencies (id, name, is_in_house, bank_name, bank_code,
  bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder)
values ('00000000-0000-0000-0000-00000000a003', 'TEST自社代理店', true,
  'テスト銀行', '0001', 'テスト支店', '001', '普通', '7654321', 'ジシャ');

-- 代理店D: 銀行名はあるがコードが無い（bank_incomplete）
insert into public.agencies (id, name, is_in_house, bank_name,
  bank_branch_name, bank_account_type, bank_account_number, bank_account_holder)
values ('00000000-0000-0000-0000-00000000a004', 'TEST代理店D', false,
  'テスト銀行', 'テスト支店', '普通', '1111111', 'テストダイリテンデイ');

-- 紹介者R: 振込先完備
insert into public.referrers (id, referrer_name, is_in_house, bank_name, bank_code,
  bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder)
values ('00000000-0000-0000-0000-00000000b001', 'TEST紹介者R', false,
  'テスト銀行', '0001', 'テスト支店', '001', '普通', '2222222', 'テストショウカイシャアール');

insert into public.creators (id, creator_name, tiktok_id, agency_id, referred_by_referrer_id)
values
  ('00000000-0000-0000-0000-00000000c001', 'TESTクリエイター1', 'tc1',
   '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b001'),
  ('00000000-0000-0000-0000-00000000c002', 'TESTクリエイター2', 'tc2',
   '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b001');

insert into public.creator_referrals (creator_id, referrer_id, lifetime_paid_amount)
values ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000b001', 0),
       ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000b001', 0);

-- 代理店Aの報酬明細: 2026-05 x1 (1000) / 2026-06 x2 (2000, 3000) / 2026-07 x1 (4000)
insert into public.agency_reward_items
  (source_row_key, target_month, creator_id, agency_id, agency_source, reward_amount)
values
  ('a-05-1', '2026-05', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', 'monthly', 1000),
  ('a-06-1', '2026-06', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', 'monthly', 2000),
  ('a-06-2', '2026-06', '00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000a001', 'monthly', 3000),
  ('a-07-1', '2026-07', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', 'monthly', 4000);

-- 対象外明細（is_reward_target=false）は占有されてはいけない
insert into public.agency_reward_items
  (source_row_key, target_month, creator_id, agency_id, reward_amount, is_reward_target)
values ('a-06-x', '2026-06', '00000000-0000-0000-0000-00000000c001',
        '00000000-0000-0000-0000-00000000a001', 9999, false);

-- 紹介者Rの報酬明細
insert into public.referral_reward_items
  (source_row_key, target_month, order_id, creator_id, referrer_id,
   base_amount, reward_amount, adjusted_reward_amount, is_reward_target)
values
  ('r-05-1', '2026-05', 'o1', '00000000-0000-0000-0000-00000000c001',
   '00000000-0000-0000-0000-00000000b001', 10000, 500, 500, true),
  ('r-06-1', '2026-06', 'o2', '00000000-0000-0000-0000-00000000c002',
   '00000000-0000-0000-0000-00000000b001', 20000, 1000, 1000, true);

-- -----------------------------------------------------------------------------
-- 1. 権限
-- -----------------------------------------------------------------------------
set test.is_admin = 'false';
select pg_temp.expect_error(
  '01 非管理者は支払明細を作成できない',
  $$select public.claim_payment_batch_items('agency','00000000-0000-0000-0000-00000000a001','2026-07', '2026-05',0,null)$$,
  '親管理者');
set test.is_admin = 'true';

-- -----------------------------------------------------------------------------
-- 2. 入力検証
-- -----------------------------------------------------------------------------
select pg_temp.expect_error('02 支払先区分が不正',
  $$select public.claim_payment_batch_items('creator','00000000-0000-0000-0000-00000000a001','2026-07', '2026-05',0,null)$$,
  '支払先区分');

select pg_temp.expect_error('03 対象月の形式が不正',
  $$select public.claim_payment_batch_items('agency','00000000-0000-0000-0000-00000000a001','2026-07', '2026/05',0,null)$$,
  '形式が不正');

select pg_temp.expect_error('04 開始月が締め対象月より後',
  $$select public.claim_payment_batch_items('agency','00000000-0000-0000-0000-00000000a001','2026-07', '2026-08',0,null)$$,
  '開始月');

-- -----------------------------------------------------------------------------
-- 3. 保留条件（振込先・自社）
-- -----------------------------------------------------------------------------
select pg_temp.expect_error('05 振込先未登録の代理店は支払明細を作れない',
  $$select public.claim_payment_batch_items('agency','00000000-0000-0000-0000-00000000a002','2026-07', '2026-05',0,null)$$,
  '振込先が未登録');

select pg_temp.expect_error('06 金融機関コード未登録は支払明細を作れない',
  $$select public.claim_payment_batch_items('agency','00000000-0000-0000-0000-00000000a004','2026-07', '2026-05',0,null)$$,
  'コード');

select pg_temp.expect_error('07 自社代理店は支払対象外',
  $$select public.claim_payment_batch_items('agency','00000000-0000-0000-0000-00000000a003','2026-07', '2026-05',0,null)$$,
  '自社');

-- -----------------------------------------------------------------------------
-- 4. 支払明細の作成
-- -----------------------------------------------------------------------------
do $$
declare
  v_batch_id uuid;
  v_batch public.payment_batches%rowtype;
  v_paid integer;
  v_claimed integer;
  v_excluded integer;
begin
  v_batch_id := public.claim_payment_batch_items(
    'agency', '00000000-0000-0000-0000-00000000a001', '2026-06', '2026-05', 0, 'テスト');

  select * into v_batch from public.payment_batches where id = v_batch_id;

  perform pg_temp.expect('08 支払明細が draft で作られる',
    v_batch.status = 'draft', v_batch.status);
  perform pg_temp.expect('09 件数が正しい（2026-05..06 の3件）',
    v_batch.item_count = 3, v_batch.item_count::text);
  perform pg_temp.expect('10 金額が正しい（1000+2000+3000）',
    v_batch.payment_amount = 6000, v_batch.payment_amount::text);

  select count(*) into v_claimed from public.agency_reward_items
   where payment_batch_id = v_batch_id;
  perform pg_temp.expect('11 対象明細が占有されている', v_claimed = 3, v_claimed::text);

  select count(*) into v_paid from public.agency_reward_items
   where payment_batch_id = v_batch_id and is_paid = true;
  perform pg_temp.expect('12 作成時点では支払済みにならない', v_paid = 0, v_paid::text);

  select count(*) into v_excluded from public.agency_reward_items
   where source_row_key = 'a-06-x' and payment_batch_id is not null;
  perform pg_temp.expect('13 対象外明細(is_reward_target=false)は占有されない',
    v_excluded = 0, v_excluded::text);

  -- 期間外（2026-07）は残る
  select count(*) into v_claimed from public.agency_reward_items
   where target_month = '2026-07' and payment_batch_id is null;
  perform pg_temp.expect('14 期間外の明細は占有されない', v_claimed = 1, v_claimed::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. 二重占有の防止
-- -----------------------------------------------------------------------------
select pg_temp.expect_error('15 同じ期間で再作成すると対象0件で失敗する',
  $$select public.claim_payment_batch_items('agency','00000000-0000-0000-0000-00000000a001','2026-06', '2026-05',0,null)$$,
  '支払対象の未払い明細がありません');

do $$
declare v_orphan integer;
begin
  -- 失敗した2回目の batch 行が残っていないこと（例外でロールバックされる）
  select count(*) into v_orphan from public.payment_batches where item_count = 0;
  perform pg_temp.expect('16 失敗した支払明細は残らない', v_orphan = 0, v_orphan::text);

  -- 1明細が2つの batch に属していないこと
  select count(*) into v_orphan from (
    select payment_batch_id from public.agency_reward_items
     where payment_batch_id is not null group by id having count(distinct payment_batch_id) > 1
  ) t;
  perform pg_temp.expect('17 同一明細が複数の支払明細に属さない', v_orphan = 0, v_orphan::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. 支払基準額
-- -----------------------------------------------------------------------------
select pg_temp.expect_error('18 支払基準額に満たない場合は作成できない',
  $$select public.claim_payment_batch_items('agency','00000000-0000-0000-0000-00000000a001','2026-07', '2026-07',999999,null)$$,
  '支払基準額');

do $$
declare v_left integer;
begin
  select count(*) into v_left from public.agency_reward_items
   where target_month = '2026-07' and payment_batch_id is null;
  perform pg_temp.expect('19 基準額未達で失敗しても占有は残らない', v_left = 1, v_left::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. 承認 → 振込先スナップショット
-- -----------------------------------------------------------------------------
do $$
declare
  v_batch_id uuid;
  v_batch public.payment_batches%rowtype;
begin
  select id into v_batch_id from public.payment_batches where status = 'draft' limit 1;

  -- 承認前はスナップショットが空
  select * into v_batch from public.payment_batches where id = v_batch_id;
  perform pg_temp.expect('20 承認前は振込先スナップショットが空',
    v_batch.bank_account_number is null, coalesce(v_batch.bank_account_number, 'null'));

  perform public.approve_payment_batch(v_batch_id);
  select * into v_batch from public.payment_batches where id = v_batch_id;

  perform pg_temp.expect('21 承認で approved になる', v_batch.status = 'approved', v_batch.status);
  perform pg_temp.expect('22 振込先がスナップショットされる',
    v_batch.bank_account_number = '1234567' and v_batch.bank_code = '0001',
    coalesce(v_batch.bank_account_number, 'null'));

  -- マスタを変更してもスナップショットは変わらない
  update public.agencies set bank_account_number = '9999999'
   where id = '00000000-0000-0000-0000-00000000a001';
  select * into v_batch from public.payment_batches where id = v_batch_id;
  perform pg_temp.expect('23 マスタ変更後もスナップショットは不変',
    v_batch.bank_account_number = '1234567', v_batch.bank_account_number);
  update public.agencies set bank_account_number = '1234567'
   where id = '00000000-0000-0000-0000-00000000a001';
end;
$$;

select pg_temp.expect_error('24 承認済みを再承認できない',
  $$select public.approve_payment_batch((select id from public.payment_batches where status='approved' limit 1))$$,
  '承認できるのは下書き');

-- -----------------------------------------------------------------------------
-- 8. CSV出力ログ
-- -----------------------------------------------------------------------------
do $$
declare v_batch_id uuid; v_n integer;
begin
  select id into v_batch_id from public.payment_batches where status = 'approved' limit 1;
  perform public.log_payment_batch_csv_export(v_batch_id);
  select count(*) into v_n from public.payment_batch_audit_logs
   where batch_id = v_batch_id and action = 'csv_exported';
  perform pg_temp.expect('25 CSV出力が監査ログに残る', v_n = 1, v_n::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. 振込完了
-- -----------------------------------------------------------------------------
do $$
declare
  v_batch_id uuid;
  v_batch public.payment_batches%rowtype;
  v_paid integer;
  v_payout public.agency_payouts%rowtype;
begin
  select id into v_batch_id from public.payment_batches where status = 'approved' limit 1;
  perform public.complete_payment_batch(v_batch_id, null, '振込完了テスト');

  select * into v_batch from public.payment_batches where id = v_batch_id;
  perform pg_temp.expect('26 振込完了で paid になる', v_batch.status = 'paid', v_batch.status);
  perform pg_temp.expect('27 paid_on が記録される', v_batch.paid_on is not null, null);

  select count(*) into v_paid from public.agency_reward_items
   where payment_batch_id = v_batch_id and is_paid = true and paid_at is not null
     and payout_id is not null;
  perform pg_temp.expect('28 報酬明細が支払済みになる（3件）', v_paid = 3, v_paid::text);

  select * into v_payout from public.agency_payouts
   where id = (select payout_id from public.agency_reward_items
                where payment_batch_id = v_batch_id limit 1);
  perform pg_temp.expect('29 agency_payouts が paid になる', v_payout.status = 'paid', v_payout.status);
  perform pg_temp.expect('30 agency_payouts の金額が明細実額と一致（累積ではない）',
    v_payout.total_reward_amount = 6000, v_payout.total_reward_amount::text);
  perform pg_temp.expect('31 payout の対象月は支払明細の終了月',
    v_payout.target_month = '2026-06', v_payout.target_month);
end;
$$;

select pg_temp.expect_error('32 支払済みを再度振込完了できない',
  $$select public.complete_payment_batch((select id from public.payment_batches where status='paid' limit 1), null, null)$$,
  '既に振込完了済み');

select pg_temp.expect_error('33 支払済みの支払明細は取消できない',
  $$select public.cancel_payment_batch((select id from public.payment_batches where status='paid' limit 1), 'test')$$,
  '取り消せません');

select pg_temp.expect_error('34 支払済みの支払明細は失敗にできない',
  $$select public.fail_payment_batch((select id from public.payment_batches where status='paid' limit 1), 'test')$$,
  '失敗にできません');

-- -----------------------------------------------------------------------------
-- 10. 支払済みは再び支払対象にならない
-- -----------------------------------------------------------------------------
do $$
declare
  v_batch_id uuid;
  v_batch public.payment_batches%rowtype;
begin
  -- 2026-05..07 で作り直すと、支払済み3件は除外され 2026-07 の1件だけになる
  v_batch_id := public.claim_payment_batch_items(
    'agency', '00000000-0000-0000-0000-00000000a001', '2026-07', '2026-05', 0, null);
  select * into v_batch from public.payment_batches where id = v_batch_id;
  perform pg_temp.expect('35 支払済み明細は再び支払対象にならない',
    v_batch.item_count = 1 and v_batch.payment_amount = 4000,
    v_batch.item_count || ' / ' || v_batch.payment_amount);
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. 取消 → 占有の解放
-- -----------------------------------------------------------------------------
do $$
declare
  v_batch_id uuid;
  v_free integer;
begin
  select id into v_batch_id from public.payment_batches where status = 'draft' limit 1;
  perform public.cancel_payment_batch(v_batch_id, '取消テスト');

  select count(*) into v_free from public.agency_reward_items
   where target_month = '2026-07' and payment_batch_id is null and is_paid = false;
  perform pg_temp.expect('36 取消で占有が解放される', v_free = 1, v_free::text);

  select count(*) into v_free from public.payment_batches
   where id = v_batch_id and status = 'cancelled';
  perform pg_temp.expect('37 支払明細が cancelled になる', v_free = 1, v_free::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. 失敗 → 占有の解放
-- -----------------------------------------------------------------------------
do $$
declare
  v_batch_id uuid;
  v_free integer;
begin
  v_batch_id := public.claim_payment_batch_items(
    'agency', '00000000-0000-0000-0000-00000000a001', '2026-07', '2026-07', 0, null);
  perform public.approve_payment_batch(v_batch_id);
  perform public.set_payment_batch_processing(v_batch_id);

  select count(*) into v_free from public.payment_batches
   where id = v_batch_id and status = 'processing';
  perform pg_temp.expect('38 承認済みを振込中にできる', v_free = 1, v_free::text);

  perform public.fail_payment_batch(v_batch_id, '口座相違');

  select count(*) into v_free from public.agency_reward_items
   where target_month = '2026-07' and payment_batch_id is null and is_paid = false;
  perform pg_temp.expect('39 失敗で占有が解放される', v_free = 1, v_free::text);

  select count(*) into v_free from public.agency_reward_items
   where target_month = '2026-07' and is_paid = true;
  perform pg_temp.expect('40 失敗で支払済みにはならない', v_free = 0, v_free::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. 紹介者（lifetime_paid_amount の更新）
-- -----------------------------------------------------------------------------
do $$
declare
  v_batch_id uuid;
  v_batch public.payment_batches%rowtype;
  v_lifetime numeric;
  v_payout public.referral_payouts%rowtype;
begin
  v_batch_id := public.claim_payment_batch_items(
    'referrer', '00000000-0000-0000-0000-00000000b001', '2026-06', '2026-05', 1000, null);
  select * into v_batch from public.payment_batches where id = v_batch_id;
  perform pg_temp.expect('41 紹介者の支払明細が作られる（2件 / 1500円）',
    v_batch.item_count = 2 and v_batch.payment_amount = 1500,
    v_batch.item_count || ' / ' || v_batch.payment_amount);

  perform public.approve_payment_batch(v_batch_id);
  perform public.complete_payment_batch(v_batch_id, current_date, null);

  select coalesce(sum(lifetime_paid_amount), 0) into v_lifetime
    from public.creator_referrals
   where referrer_id = '00000000-0000-0000-0000-00000000b001';
  perform pg_temp.expect('42 lifetime_paid_amount が加算される（合計1500）',
    v_lifetime = 1500, v_lifetime::text);

  select * into v_payout from public.referral_payouts
   where referrer_id = '00000000-0000-0000-0000-00000000b001' limit 1;
  perform pg_temp.expect('43 referral_payouts が paid / 実額になる',
    v_payout.status = 'paid' and v_payout.total_reward_amount = 1500,
    v_payout.status || ' / ' || v_payout.total_reward_amount);
end;
$$;

-- -----------------------------------------------------------------------------
-- 14. 監査ログ
-- -----------------------------------------------------------------------------
do $$
declare v_actions text;
begin
  select string_agg(distinct action, ',' order by action) into v_actions
    from public.payment_batch_audit_logs;
  perform pg_temp.expect('44 監査ログに全操作が記録される',
    v_actions = 'approved,cancelled,created,csv_exported,failed,paid,processing', v_actions);
end;
$$;

do $$
declare v_n integer;
begin
  select count(*) into v_n from public.payment_batch_audit_logs
   where actor_id is null or actor_email is null;
  perform pg_temp.expect('45 監査ログに操作者が記録される', v_n = 0, v_n::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 15. 件数・金額の不一致でロールバックされること
-- -----------------------------------------------------------------------------
do $$
declare v_batch_id uuid;
begin
  v_batch_id := public.claim_payment_batch_items(
    'agency', '00000000-0000-0000-0000-00000000a001', '2026-07', '2026-07', 0, null);
  perform public.approve_payment_batch(v_batch_id);
  -- 支払明細のスナップショットだけを改ざんする
  update public.payment_batches set payment_amount = 99999 where id = v_batch_id;
  perform set_config('test.batch_id', v_batch_id::text, false);
end;
$$;

select pg_temp.expect_error('46 金額がスナップショットと不一致なら中止',
  $$select public.complete_payment_batch(current_setting('test.batch_id')::uuid, null, null)$$,
  '金額が支払明細と一致しません');

do $$
declare v_paid integer;
begin
  select count(*) into v_paid from public.agency_reward_items
   where target_month = '2026-07' and is_paid = true;
  perform pg_temp.expect('47 不一致で中止したとき支払済みにならない', v_paid = 0, v_paid::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 16. 旧支払RPC が支払明細に占有中の明細を払わないこと
-- -----------------------------------------------------------------------------
-- /revenue の旧「支払確定」経路が残っている間の二重支払い防止。
-- migration 20260925104000 で WHERE に payment_batch_id is null を足してある。
do $$
declare
  v_payout_id uuid;
  v_claimed integer;
begin
  /*
    直前の 15 で作った支払明細が 2026-07 の明細を占有したまま approved で残っている。
    その状態のまま旧RPCを呼んで、占有中の明細が支払われないことを確かめる。
  */
  select count(*) into v_claimed
    from public.agency_reward_items
   where payment_batch_id = current_setting('test.batch_id')::uuid;
  perform pg_temp.expect('48 旧RPC検証の前提: 明細が占有されている', v_claimed = 1, v_claimed::text);

  insert into public.agency_payouts (target_month, agency_id, threshold_amount, is_payable, status)
  values ('2026-07', '00000000-0000-0000-0000-00000000a001', 0, true, 'unpaid')
  on conflict (target_month, agency_id) do update set status = 'unpaid'
  returning id into v_payout_id;

  perform set_config('test.payout_id', v_payout_id::text, false);
end;
$$;

select pg_temp.expect_error('49 旧代理店RPCは占有中の明細を支払えない',
  $$select public.mark_agency_payout_paid_annual(current_setting('test.payout_id')::uuid)$$,
  '支払対象の未払い明細がありません');

do $$
declare v_paid integer;
begin
  select count(*) into v_paid from public.agency_reward_items
   where payment_batch_id = current_setting('test.batch_id')::uuid and is_paid = true;
  perform pg_temp.expect('50 旧RPC実行後も占有中の明細は未払いのまま', v_paid = 0, v_paid::text);
end;
$$;

do $$
declare v_free integer;
begin
  -- 後片付け（占有を解放して他のテストに影響させない）
  perform public.cancel_payment_batch(current_setting('test.batch_id')::uuid, 'cleanup');
  select count(*) into v_free from public.agency_reward_items
   where target_month = '2026-07' and payment_batch_id is null and is_paid = false;
  perform pg_temp.expect('51 取消で占有が解放される（旧RPC検証の後片付け）', v_free = 1, v_free::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- 結果
-- -----------------------------------------------------------------------------
\echo ''
\echo '================= 支払明細 RPC 検証結果 ================='
select seq,
       case when ok then 'PASS' else 'FAIL' end as result,
       name,
       coalesce(detail, '') as detail
  from test_results order by seq;

\echo ''
select count(*) filter (where ok) as passed,
       count(*) filter (where not ok) as failed,
       count(*) as total
  from test_results;

do $$
declare v_failed integer;
begin
  select count(*) into v_failed from test_results where not ok;
  if v_failed > 0 then
    raise exception 'RPC検証に失敗しました（% 件）', v_failed;
  end if;
end;
$$;
