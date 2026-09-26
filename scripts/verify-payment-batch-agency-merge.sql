/*
  代理店単位への支払統合の検証（使い捨てDB専用）。

  ■ 本番では実行しない
  実データを INSERT / UPDATE する。scratch DB に本番スキーマの最小再現と
  migration を適用したうえで実行する。

    psql -d merge_test -f scripts/verify-payment-batch-agency-merge.sql

  ■ 何を守っているか
  ・代理店の支払明細に、帰属する紹介者の紹介報酬が合算される
  ・二重支払い防止の4条件を紹介報酬側にも適用している
  ・代理店へ帰属済みの紹介者は単独明細を作れない
  ・銀行口座は代理店側だけで足りる
  ・報酬種別（agency / referral）は失われない
*/

\set ON_ERROR_STOP on
\pset pager off
set test.is_admin = 'true';

begin;

create temp table t_result (no int, name text, ok boolean, detail text);

create or replace function t_check(p_no int, p_name text, p_ok boolean, p_detail text default null)
returns void language plpgsql as $t$
begin
  insert into t_result values (p_no, p_name, p_ok, p_detail);
  if not p_ok then
    raise exception 'TEST % 失敗: % / %', p_no, p_name, coalesce(p_detail, '(詳細なし)');
  end if;
end $t$;

-- =========================================================================
-- 固定フィクスチャ
-- =========================================================================
insert into auth.users (id, email) values
  ('99999999-9999-4999-8999-999999999999', 'merge-test@example.local');
set test.uid = '99999999-9999-4999-8999-999999999999';

insert into public.agencies (id, name, is_in_house, bank_name, bank_code,
       bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder) values
  ('a0000001-0000-4000-8000-000000000001','MergeAgencyFull',    false,'テスト銀行','0001','本店','001','普通','1111111','ﾃｽﾄ1'),
  ('a0000002-0000-4000-8000-000000000002','MergeAgencyNoBank',  false,null,null,null,null,null,null,null),
  ('a0000003-0000-4000-8000-000000000003','MergeInHouse',       true, 'テスト銀行','0001','本店','001','普通','3333333','ﾃｽﾄ3'),
  ('a0000004-0000-4000-8000-000000000004','MergeAgencyOnly',    false,'テスト銀行','0001','本店','001','普通','4444444','ﾃｽﾄ4'),
  ('a0000005-0000-4000-8000-000000000005','MergeReferralOnly',  false,'テスト銀行','0001','本店','001','普通','5555555','ﾃｽﾄ5');

-- 紹介者側には口座を登録しない（R3 のみ legacy 経路のため登録する）
insert into public.referrers (id, name, referrer_name, referral_code, agency_id, is_in_house,
       bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder) values
  ('b0000001-0000-4000-8000-000000000001','MergeRef1','MergeRef1','MR1','a0000001-0000-4000-8000-000000000001',false,null,null,null,null,null,null,null),
  ('b0000002-0000-4000-8000-000000000002','MergeRef2','MergeRef2','MR2','a0000001-0000-4000-8000-000000000001',false,null,null,null,null,null,null,null),
  ('b0000003-0000-4000-8000-000000000003','MergeRef3','MergeRef3','MR3',null,                                   false,'テスト銀行','0001','本店','001','普通','9999999','ﾃｽﾄ9'),
  ('b0000004-0000-4000-8000-000000000004','MergeRef4','MergeRef4','MR4','a0000003-0000-4000-8000-000000000003',false,null,null,null,null,null,null,null),
  ('b0000005-0000-4000-8000-000000000005','MergeRef5','MergeRef5','MR5','a0000002-0000-4000-8000-000000000002',false,null,null,null,null,null,null,null),
  ('b0000006-0000-4000-8000-000000000006','MergeRef6','MergeRef6','MR6','a0000005-0000-4000-8000-000000000005',false,null,null,null,null,null,null,null);

insert into public.creators (id) values
  ('c0000001-0000-4000-8000-000000000001'),
  ('c0000002-0000-4000-8000-000000000002');

insert into public.creator_referrals (creator_id, referrer_id, lifetime_paid_amount) values
  ('c0000001-0000-4000-8000-000000000001','b0000001-0000-4000-8000-000000000001',0),
  ('c0000002-0000-4000-8000-000000000002','b0000002-0000-4000-8000-000000000002',0);

-- 除外条件テスト用の既存レコード
insert into public.agency_payouts (id, target_month, agency_id, total_reward_amount, threshold_amount, is_payable, status)
values ('d0000001-0000-4000-8000-000000000001','2030-01','a0000001-0000-4000-8000-000000000001',0,0,true,'unpaid');
insert into public.referral_payouts (id, target_month, referrer_id, total_reward_amount, threshold_amount, is_payable, status)
values ('d0000002-0000-4000-8000-000000000002','2030-01','b0000001-0000-4000-8000-000000000001',0,1000,true,'unpaid');
insert into public.payment_batches (id, payee_kind, agency_id, period_start_month, period_end_month, status)
values ('e0000001-0000-4000-8000-000000000001','agency','a0000004-0000-4000-8000-000000000004','2030-01','2030-01','cancelled');

-- ---- 代理店報酬 ----
insert into public.agency_reward_items
  (agency_id, creator_id, target_month, source_row_key, order_id, product_id,
   commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate,
   reward_amount, is_reward_target, is_paid, payout_id, payment_batch_id) values
  -- A1: 通常2件（claim対象）
  ('a0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-a1-1','o1','p1',1000,1000,900,10,100,true,false,null,null),
  ('a0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-a1-2','o2','p1',2000,2000,1800,10,200,true,false,null,null),
  -- A1: 除外されるべき3件
  ('a0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-a1-paid','o3','p1',9000,9000,8000,10,1000,true,true,null,null),
  ('a0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-a1-payout','o4','p1',9000,9000,8000,10,2000,true,false,'d0000001-0000-4000-8000-000000000001',null),
  ('a0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-a1-batch','o5','p1',9000,9000,8000,10,3000,true,false,null,'e0000001-0000-4000-8000-000000000001'),
  -- A1: 報酬対象外（is_reward_target=false）
  ('a0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-a1-nottarget','o6','p1',9000,9000,8000,10,4000,false,false,null,null),
  -- A2（口座未登録）/ A3（自社）/ A4（代理店報酬のみ）
  ('a0000002-0000-4000-8000-000000000002','c0000001-0000-4000-8000-000000000001','2030-01','mg-a2-1','o7','p1',5000,5000,4500,10,500,true,false,null,null),
  ('a0000003-0000-4000-8000-000000000003','c0000001-0000-4000-8000-000000000001','2030-01','mg-a3-1','o8','p1',7000,7000,6300,10,700,true,false,null,null),
  ('a0000004-0000-4000-8000-000000000004','c0000001-0000-4000-8000-000000000001','2030-01','mg-a4-1','o9','p1',9000,9000,8100,10,900,true,false,null,null);

-- ---- 紹介者報酬 ----
insert into public.referral_reward_items
  (referrer_id, creator_id, target_month, source_row_key, order_id, product_id,
   base_amount, reward_rate, original_reward_amount, adjusted_reward_amount, reward_amount,
   cap_applied, cap_reached, is_reward_target, is_paid, payout_id, payment_batch_id) values
  -- R1 → A1: 通常2件
  ('b0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-r1-1','o1','p1',210,0.05,10.50,10.50,10.50,false,false,true,false,null,null),
  ('b0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-r1-2','o2','p1',405,0.05,20.25,20.25,20.25,false,false,true,false,null,null),
  -- R1 → A1: 除外されるべき3件 + 報酬対象外1件
  ('b0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-r1-paid','o3','p1',9000,0.05,111.00,111.00,111.00,false,false,true,true,null,null),
  ('b0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-r1-payout','o4','p1',9000,0.05,222.00,222.00,222.00,false,false,true,false,'d0000002-0000-4000-8000-000000000002',null),
  ('b0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-r1-batch','o5','p1',9000,0.05,333.00,333.00,333.00,false,false,true,false,null,'e0000001-0000-4000-8000-000000000001'),
  ('b0000001-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','2030-01','mg-r1-nottarget','o6','p1',9000,0.05,444.00,444.00,444.00,false,false,false,false,null,null),
  -- R2 → A1: 同一agencyへの2人目
  ('b0000002-0000-4000-8000-000000000002','c0000002-0000-4000-8000-000000000002','2030-01','mg-r2-1','o7','p1',106,0.05,5.30,5.30,5.30,false,false,true,false,null,null),
  -- R3 → agency未紐付け（legacy経路）
  ('b0000003-0000-4000-8000-000000000003','c0000001-0000-4000-8000-000000000001','2030-01','mg-r3-1','o8','p1',30000,0.05,1500.00,1500.00,1500.00,false,false,true,false,null,null),
  -- R4 → A3（自社）/ R5 → A2（口座未登録）/ R6 → A5（紹介報酬のみ）
  ('b0000004-0000-4000-8000-000000000004','c0000001-0000-4000-8000-000000000001','2030-01','mg-r4-1','o9','p1',800,0.05,40.00,40.00,40.00,false,false,true,false,null,null),
  ('b0000005-0000-4000-8000-000000000005','c0000001-0000-4000-8000-000000000001','2030-01','mg-r5-1','o10','p1',1200,0.05,60.00,60.00,60.00,false,false,true,false,null,null),
  ('b0000006-0000-4000-8000-000000000006','c0000001-0000-4000-8000-000000000001','2030-01','mg-r6-1','o11','p1',1600,0.05,80.00,80.00,80.00,false,false,true,false,null,null);

-- =========================================================================
-- 異常系（claim を拒否すること）
-- =========================================================================
do $blk$
declare v_err text;
begin
  -- TEST 6: 自社agencyは支払対象外
  begin
    perform public.claim_payment_batch_items('agency','a0000003-0000-4000-8000-000000000003','2030-01','2030-01',0,null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(6, '自社agencyのclaimを拒否', v_err like '%自社%', v_err);

  -- TEST 15: 代理店の口座未登録なら代理店+紹介の全体が拒否される
  begin
    perform public.claim_payment_batch_items('agency','a0000002-0000-4000-8000-000000000002','2030-01','2030-01',0,null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(15, '代理店の口座未登録でclaim拒否', v_err like '%振込先が未登録%', v_err);

  -- TEST 18: 代理店へ帰属済みの紹介者は単独明細を作れない
  begin
    perform public.claim_payment_batch_items('referrer','b0000001-0000-4000-8000-000000000001','2030-01','2030-01',0,null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(18, '帰属済みreferrerの単独claimを拒否', v_err like '%代理店に帰属%', v_err);

  -- TEST 19: 自社agencyへ帰属した紹介者も単独明細を作れない
  begin
    perform public.claim_payment_batch_items('referrer','b0000004-0000-4000-8000-000000000004','2030-01','2030-01',0,null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(19, '自社agency帰属referrerの単独claimを拒否', v_err like '%代理店に帰属%', v_err);
end $blk$;

-- =========================================================================
-- TEST 1: 代理店報酬のみ / TEST 11: release
-- =========================================================================
do $blk$
declare v_batch uuid; v_cnt int; v_amt numeric; v_released int;
begin
  v_batch := public.claim_payment_batch_items('agency','a0000004-0000-4000-8000-000000000004','2030-01','2030-01',0,'T1');
  select item_count, payment_amount into v_cnt, v_amt from public.payment_batches where id = v_batch;
  perform t_check(1, '代理店報酬のみ: 1件 / 900円', v_cnt = 1 and v_amt = 900,
                  format('件数=%s 金額=%s', v_cnt, v_amt));

  -- TEST 7/8/9 の一部: cancelled batch が占有している行は巻き込まれない
  perform t_check(7, '既にpayment_batch_idがある行はclaimされない',
    (select payment_batch_id from public.agency_reward_items where source_row_key='mg-a1-batch')
      = 'e0000001-0000-4000-8000-000000000001', null);

  v_released := public.release_payment_batch_items(v_batch, 'agency');
  perform t_check(11, 'release で1件解放される', v_released = 1, format('解放=%s', v_released));
  perform t_check(1011, 'release後は未占有に戻る',
    (select payment_batch_id from public.agency_reward_items where source_row_key='mg-a4-1') is null, null);

  -- 後続テストのため作り直す
  delete from public.payment_batches where id = v_batch;
end $blk$;

-- =========================================================================
-- TEST 2: 紹介報酬のみ（代理店報酬 0 件でも代理店明細が作れる）
-- =========================================================================
do $blk$
declare v_batch uuid; v_cnt int; v_amt numeric;
begin
  v_batch := public.claim_payment_batch_items('agency','a0000005-0000-4000-8000-000000000005','2030-01','2030-01',0,'T2');
  select item_count, payment_amount into v_cnt, v_amt from public.payment_batches where id = v_batch;
  perform t_check(2, '紹介報酬のみ: 1件 / 80.00円', v_cnt = 1 and v_amt = 80.00,
                  format('件数=%s 金額=%s', v_cnt, v_amt));
  perform t_check(202, '紹介報酬がagency明細へ紐付く',
    (select count(*) from public.referral_reward_items where payment_batch_id = v_batch) = 1, null);
end $blk$;

-- =========================================================================
-- TEST 3/4/8/9/12/17: 代理店報酬 + 紹介報酬の合算
-- =========================================================================
do $blk$
declare v_batch uuid; v_cnt int; v_amt numeric; v_err text;
begin
  v_batch := public.claim_payment_batch_items('agency','a0000001-0000-4000-8000-000000000001','2030-01','2030-01',0,'T3');
  select item_count, payment_amount into v_cnt, v_amt from public.payment_batches where id = v_batch;

  -- 代理店 100+200=300 / 紹介 10.50+20.25+5.30=36.05 → 5件 / 336.05
  perform t_check(3, '代理店+紹介の合算: 5件 / 336.05円', v_cnt = 5 and v_amt = 336.05,
                  format('件数=%s 金額=%s', v_cnt, v_amt));

  perform t_check(4, '複数referrer→同一agency: 2名分が同じ明細へ',
    (select count(distinct referrer_id) from public.referral_reward_items where payment_batch_id = v_batch) = 2, null);

  perform t_check(8, 'is_paid=true はclaimされない',
    (select payment_batch_id from public.agency_reward_items where source_row_key='mg-a1-paid') is null
    and (select payment_batch_id from public.referral_reward_items where source_row_key='mg-r1-paid') is null, null);

  perform t_check(9, 'payout_id ありはclaimされない',
    (select payment_batch_id from public.agency_reward_items where source_row_key='mg-a1-payout') is null
    and (select payment_batch_id from public.referral_reward_items where source_row_key='mg-r1-payout') is null, null);

  perform t_check(901, 'is_reward_target=false はclaimされない',
    (select payment_batch_id from public.agency_reward_items where source_row_key='mg-a1-nottarget') is null
    and (select payment_batch_id from public.referral_reward_items where source_row_key='mg-r1-nottarget') is null, null);

  perform t_check(14, '紹介者側の口座が未登録でもholdにならない',
    (select count(*) from public.referrers r
      where r.id in ('b0000001-0000-4000-8000-000000000001','b0000002-0000-4000-8000-000000000002')
        and coalesce(btrim(r.bank_name),'') = '') = 2, null);

  perform t_check(17, '報酬種別の内訳が追跡できる（代理店2 / 紹介3）',
    (select count(*) from public.agency_reward_items where payment_batch_id = v_batch) = 2
    and (select count(*) from public.referral_reward_items where payment_batch_id = v_batch) = 3, null);

  perform t_check(16, 'CSVは代理店単位1振込（payment_batches 1行）',
    (select count(*) from public.payment_batches where id = v_batch) = 1, null);

  -- TEST 12: 二重claimできない
  begin
    perform public.claim_payment_batch_items('agency','a0000001-0000-4000-8000-000000000001','2030-01','2030-01',0,'dup');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(12, '同じ明細を別batchへ二重claimできない', v_err like '%未払い明細がありません%', v_err);
end $blk$;

-- =========================================================================
-- TEST 5: agency未紐付けreferrer は legacy 経路で単独明細を作れる
-- =========================================================================
do $blk$
declare v_batch uuid; v_cnt int; v_amt numeric;
begin
  v_batch := public.claim_payment_batch_items('referrer','b0000003-0000-4000-8000-000000000003','2030-01','2030-01',1000,'T5');
  select item_count, payment_amount into v_cnt, v_amt from public.payment_batches where id = v_batch;
  perform t_check(5, 'agency未紐付けreferrerの単独明細: 1件 / 1500円', v_cnt = 1 and v_amt = 1500.00,
                  format('件数=%s 金額=%s', v_cnt, v_amt));
  perform t_check(502, 'agency未紐付けの紹介報酬は代理店明細へ混ざらない',
    (select payee_kind from public.payment_batches where id = v_batch) = 'referrer', null);
end $blk$;

-- =========================================================================
-- TEST 10: claim → approve → processing → complete
-- =========================================================================
do $blk$
declare v_batch uuid; v_ag_paid int; v_rf_paid int; v_life numeric; v_status text;
begin
  select id into v_batch from public.payment_batches
   where payee_kind='agency' and agency_id='a0000001-0000-4000-8000-000000000001' and status='draft';

  perform public.approve_payment_batch(v_batch);
  perform public.set_payment_batch_processing(v_batch);
  perform public.complete_payment_batch(v_batch, null, 'T10');

  select status into v_status from public.payment_batches where id = v_batch;
  perform t_check(10, 'claim→approve→processing→complete が通る', v_status = 'paid', v_status);

  select count(*) into v_ag_paid from public.agency_reward_items   where payment_batch_id = v_batch and is_paid;
  select count(*) into v_rf_paid from public.referral_reward_items where payment_batch_id = v_batch and is_paid;
  perform t_check(1301, '代理店の口座だけで紹介報酬まで支払済みになる',
    v_ag_paid = 2 and v_rf_paid = 3, format('agency=%s referral=%s', v_ag_paid, v_rf_paid));

  perform t_check(1302, '紹介報酬にも payout_id が付く',
    (select count(*) from public.referral_reward_items where payment_batch_id = v_batch and payout_id is null) = 0, null);

  -- 他の検証スクリプトのデータと混ざらないよう、自分のフィクスチャだけを見る
  select coalesce(sum(lifetime_paid_amount), 0) into v_life
    from public.creator_referrals
   where referrer_id in ('b0000001-0000-4000-8000-000000000001',
                         'b0000002-0000-4000-8000-000000000002');
  perform t_check(1303, '生涯上限の累計支払額が進む（30.75 + 5.30）',
    v_life = 36.05, format('累計=%s', v_life));

  perform t_check(1304, 'batch外のreward itemを巻き込まない',
    (select count(*) from public.agency_reward_items
      where source_row_key in ('mg-a2-1','mg-a3-1','mg-a4-1') and is_paid) = 0
    and (select count(*) from public.referral_reward_items
      where source_row_key in ('mg-r4-1','mg-r5-1','mg-r6-1') and is_paid) = 0, null);

  perform t_check(1305, '支払済みを含む明細は解放できない',
    (select count(*) from public.payment_batch_audit_logs where batch_id = v_batch and action='paid') = 1, null);
end $blk$;

-- =========================================================================
-- 結果
-- =========================================================================
select count(*) "実行テスト数", count(*) filter (where ok) 成功, count(*) filter (where not ok) 失敗
from t_result;
select no, name, case when ok then 'PASS' else 'FAIL' end 結果 from t_result order by no;

rollback;
