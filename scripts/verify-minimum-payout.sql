/*
  最低支払額（¥1,000）の実挙動の検証（使い捨てDB専用）。

  ■ 本番では実行しない
  実データを INSERT / UPDATE する。scratch DB に本番スキーマの最小再現と
  migration を適用したうえで実行する。

    psql -d minpay -f scripts/verify-minimum-payout.sql

  ■ 何を守っているか
  ・判定は単月ではなく「締め月までの未払い累積」
  ・累積が最低支払額未満なら支払明細を作らない
  ・拒否されたとき明細が占有されたまま残らない（ロールバックされる）
  ・明細は消さず is_paid にもしない（翌月へ繰り越す）
  ・承認時にも最低支払額を確認する
  ・一括承認で1件でも未満が混ざれば全件ロールバック
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

/* claim のときに UI が渡す最低支払額。lib/payments/minimum-payout.ts と同じ */
create or replace function t_min() returns numeric language sql immutable as $t$ select 1000::numeric $t$;

-- =========================================================================
-- フィクスチャ（口座は全社完備）
-- =========================================================================
insert into auth.users (id, email) values
  ('44444444-4444-4444-8444-444444444444', 'minpay@example.local');
set test.uid = '44444444-4444-4444-8444-444444444444';

insert into public.agencies (id, name, is_in_house, bank_name, bank_code,
       bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder) values
  ('a1a00001-0000-4000-8000-000000000001','MP_Over',  false,'テスト銀行','0001','本店','001','普通','1111111','ﾃｽﾄ1'),
  ('a1a00002-0000-4000-8000-000000000002','MP_Under', false,'テスト銀行','0002','二号店','002','普通','2222222','ﾃｽﾄ2'),
  ('a1a00003-0000-4000-8000-000000000003','MP_Exact', false,'テスト銀行','0003','三号店','003','普通','3333333','ﾃｽﾄ3'),
  ('a1a00004-0000-4000-8000-000000000004','MP_999',   false,'テスト銀行','0004','四号店','004','普通','4444444','ﾃｽﾄ4'),
  ('a1a00005-0000-4000-8000-000000000005','MP_Split', false,'テスト銀行','0005','五号店','005','普通','5555555','ﾃｽﾄ5');

insert into public.creators (id) values ('a1c00001-0000-4000-8000-000000000001');

/*
  MP_Over  : 2026-07 に 2,000（支払対象）
  MP_Under : 2026-07 に   500（未満）
  MP_Exact : 2026-07 に 1,000（境界・支払対象）
  MP_999   : 2026-07 に   999（境界・未満）
  MP_Split : 2026-06 に   600 / 2026-07 に 600（累積 1,200 で支払対象）
*/
insert into public.agency_reward_items
  (agency_id, creator_id, target_month, source_row_key, order_id, product_id,
   commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate,
   reward_amount, is_reward_target, is_paid) values
  ('a1a00001-0000-4000-8000-000000000001','a1c00001-0000-4000-8000-000000000001','2026-07','mp-over','o1','p1',20000,20000,20000,10,2000,true,false),
  ('a1a00002-0000-4000-8000-000000000002','a1c00001-0000-4000-8000-000000000001','2026-07','mp-under','o2','p1',5000,5000,5000,10,500,true,false),
  ('a1a00003-0000-4000-8000-000000000003','a1c00001-0000-4000-8000-000000000001','2026-07','mp-exact','o3','p1',10000,10000,10000,10,1000,true,false),
  ('a1a00004-0000-4000-8000-000000000004','a1c00001-0000-4000-8000-000000000001','2026-07','mp-999','o4','p1',9990,9990,9990,10,999,true,false),
  ('a1a00005-0000-4000-8000-000000000005','a1c00001-0000-4000-8000-000000000001','2026-06','mp-split-06','o5','p1',6000,6000,6000,10,600,true,false),
  ('a1a00005-0000-4000-8000-000000000005','a1c00001-0000-4000-8000-000000000001','2026-07','mp-split-07','o6','p1',6000,6000,6000,10,600,true,false);

-- =========================================================================
-- TEST 1/4: 累積が最低支払額以上なら claim できる
-- =========================================================================
do $blk$
declare v_b uuid; v_amt numeric;
begin
  v_b := public.claim_payment_batch_items(
    'agency','a1a00001-0000-4000-8000-000000000001','2026-07','2026-01', t_min(), null);
  select payment_amount into v_amt from public.payment_batches where id = v_b;
  perform t_check(1, '累積 ¥2,000 は claim できる', v_amt = 2000, format('金額=%s', v_amt));

  v_b := public.claim_payment_batch_items(
    'agency','a1a00003-0000-4000-8000-000000000003','2026-07','2026-01', t_min(), null);
  select payment_amount into v_amt from public.payment_batches where id = v_b;
  perform t_check(4, 'ちょうど ¥1,000 は claim できる（境界）', v_amt = 1000, format('金額=%s', v_amt));
end $blk$;

-- =========================================================================
-- TEST 2/5/6/7: 最低支払額未満は claim できず、明細も残らない
-- =========================================================================
do $blk$
declare v_err text; v_batches int;
begin
  select count(*) into v_batches from public.payment_batches;

  -- TEST 2: ¥500
  begin
    perform public.claim_payment_batch_items(
      'agency','a1a00002-0000-4000-8000-000000000002','2026-07','2026-01', t_min(), null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(2, '累積 ¥500 は claim を拒否される', v_err like '%支払基準額に達していません%', v_err);

  -- TEST 5: ¥999
  begin
    perform public.claim_payment_batch_items(
      'agency','a1a00004-0000-4000-8000-000000000004','2026-07','2026-01', t_min(), null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(5, '累積 ¥999 は claim を拒否される（境界）', v_err like '%支払基準額に達していません%', v_err);

  -- TEST 6: 拒否されたとき payment_batch_id が残らない
  perform t_check(6, '拒否時に明細が占有されたまま残らない',
    (select count(*) from public.agency_reward_items
      where source_row_key in ('mp-under','mp-999') and payment_batch_id is not null) = 0, null);

  perform t_check(601, '拒否時に空の支払明細も残らない',
    (select count(*) from public.payment_batches) = v_batches,
    format('前=%s 後=%s', v_batches, (select count(*) from public.payment_batches)));

  -- TEST 7: is_paid / payout_id / 金額は変わらない（消さない）
  perform t_check(7, '拒否されても明細は消えず is_paid も変わらない',
    (select count(*) from public.agency_reward_items
      where source_row_key in ('mp-under','mp-999')
        and is_reward_target and not is_paid and payout_id is null) = 2, null);

  perform t_check(701, '金額も変わらない',
    (select reward_amount from public.agency_reward_items where source_row_key='mp-under') = 500
    and (select reward_amount from public.agency_reward_items where source_row_key='mp-999') = 999, null);
end $blk$;

-- =========================================================================
-- TEST 3/8: 単月では未満でも累積で達すれば claim できる（繰越の成立）
-- =========================================================================
do $blk$
declare v_err text; v_b uuid; v_amt numeric; v_cnt int;
begin
  -- 2026-06 で締めると 600 なので拒否される
  begin
    perform public.claim_payment_batch_items(
      'agency','a1a00005-0000-4000-8000-000000000005','2026-06','2026-01', t_min(), null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(8, '6月末締めでは単月 ¥600 なので繰越（claim 拒否）',
    v_err like '%支払基準額に達していません%', v_err);

  -- 2026-07 で締めると 600 + 600 = 1,200 で claim できる
  v_b := public.claim_payment_batch_items(
    'agency','a1a00005-0000-4000-8000-000000000005','2026-07','2026-01', t_min(), null);
  select payment_amount, item_count into v_amt, v_cnt
    from public.payment_batches where id = v_b;
  perform t_check(3, '7月末締めなら累積 ¥1,200（600+600）で claim できる',
    v_amt = 1200 and v_cnt = 2, format('金額=%s 件数=%s', v_amt, v_cnt));

  perform t_check(801, '6月分も同じ支払明細に入る（繰越分がまとめて支払われる）',
    (select count(*) from public.agency_reward_items
      where payment_batch_id = v_b and target_month = '2026-06') = 1, null);
end $blk$;

-- =========================================================================
-- TEST 9/10: 承認時にも最低支払額を確認する
-- =========================================================================
do $blk$
declare v_b_ok uuid; v_b_low uuid; v_err text;
begin
  select id into v_b_ok from public.payment_batches
   where agency_id = 'a1a00001-0000-4000-8000-000000000001';

  /*
    claim 後に報酬が下がった下書きを再現する。
    支払明細と明細の整合も崩れるが、最低支払額の判定が先に効くことを確認する。
  */
  select id into v_b_low from public.payment_batches
   where agency_id = 'a1a00003-0000-4000-8000-000000000003';
  update public.payment_batches set payment_amount = 800 where id = v_b_low;

  -- TEST 9: 単体承認が拒否される
  begin
    perform public.approve_payment_batch(v_b_low);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(9, '最低支払額未満の下書きは単体承認できない',
    v_err like '%最低支払額に達していない%', v_err);
  perform t_check(901, '拒否された下書きは draft のまま',
    (select status from public.payment_batches where id = v_b_low) = 'draft', null);

  -- TEST 10: 一括承認で1件でも未満が混ざれば全件ロールバック
  begin
    perform public.approve_payment_batches_bulk(array[v_b_ok, v_b_low]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(10, '一括承認に未満が混ざると失敗する',
    v_err like '%最低支払額に達していない%', v_err);
  perform t_check(1001, '未満が混ざったとき他の明細も承認されない（全ロールバック）',
    (select count(*) from public.payment_batches
      where id in (v_b_ok, v_b_low) and status = 'draft') = 2, null);
  perform t_check(1002, '振込先も固定されていない',
    (select count(*) from public.payment_batches
      where id in (v_b_ok, v_b_low) and bank_name is not null) = 0, null);

  -- 元に戻して、基準額を満たす明細だけなら承認できることを確認
  update public.payment_batches set payment_amount = 1000 where id = v_b_low;
  perform t_check(1003, '基準額を満たす明細だけなら一括承認できる',
    public.approve_payment_batches_bulk(array[v_b_ok, v_b_low]) = 2, null);
  perform t_check(1004, '承認後は approved になる',
    (select count(*) from public.payment_batches
      where id in (v_b_ok, v_b_low) and status = 'approved') = 2, null);
end $blk$;

-- =========================================================================
-- 支払状態は変わらない
-- =========================================================================
do $blk$
begin
  perform t_check(1101, '承認しても is_paid は変わらない',
    (select count(*) from public.agency_reward_items where is_paid) = 0, null);
  perform t_check(1102, '承認しても payout_id は付かない',
    (select count(*) from public.agency_reward_items where payout_id is not null) = 0, null);
  perform t_check(1103, '未満の明細は最後まで未払い・未占有のまま',
    (select count(*) from public.agency_reward_items
      where source_row_key in ('mp-under','mp-999')
        and payment_batch_id is null and not is_paid and payout_id is null) = 2, null);
end $blk$;

-- =========================================================================
-- 結果
-- =========================================================================
select count(*) "実行テスト数", count(*) filter (where ok) 成功, count(*) filter (where not ok) 失敗
from t_result;
select no, name, case when ok then 'PASS' else 'FAIL' end 結果 from t_result order by no;

rollback;
