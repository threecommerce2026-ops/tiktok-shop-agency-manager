/*
  締め対象月（cutoff_month）の検証（使い捨てDB専用）。

  ■ 本番では実行しない
  実データを INSERT / UPDATE する。scratch DB に本番スキーマの最小再現と
  migration を適用したうえで実行する。

    psql -d cutoff_test -f scripts/verify-payment-batch-cutoff.sql

  ■ 何を守っているか
  ・締め対象月より後の明細は絶対に claim されない
  ・締め月を迂回する引数経路が残っていない
  ・未来月・不正な YYYY-MM を拒否する
  ・支払明細に締め月が保存され、後から判定できる
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
-- フィクスチャ
-- =========================================================================
insert into auth.users (id, email) values
  ('88888888-8888-4888-8888-888888888888', 'cutoff-test@example.local');
set test.uid = '88888888-8888-4888-8888-888888888888';

insert into public.agencies (id, name, is_in_house, bank_name, bank_code,
       bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder) values
  ('c0a00001-0000-4000-8000-000000000001','CutAgencyFull',  false,'テスト銀行','0001','本店','001','普通','1111111','ﾃｽﾄ1'),
  ('c0a00002-0000-4000-8000-000000000002','CutAgencyNoBank',false,null,null,null,null,null,null,null),
  ('c0a00003-0000-4000-8000-000000000003','CutInHouse',     true, 'テスト銀行','0001','本店','001','普通','3333333','ﾃｽﾄ3');

insert into public.referrers (id, name, referrer_name, referral_code, agency_id, is_in_house) values
  ('c0b00001-0000-4000-8000-000000000001','CutRef1','CutRef1','CR1','c0a00001-0000-4000-8000-000000000001',false),
  ('c0b00002-0000-4000-8000-000000000002','CutRef2','CutRef2','CR2','c0a00001-0000-4000-8000-000000000001',false),
  ('c0b00003-0000-4000-8000-000000000003','CutRef3','CutRef3','CR3','c0a00002-0000-4000-8000-000000000002',false);

insert into public.creators (id) values
  ('c0c00001-0000-4000-8000-000000000001'),
  ('c0c00002-0000-4000-8000-000000000002');

insert into public.creator_referrals (creator_id, referrer_id, lifetime_paid_amount) values
  ('c0c00001-0000-4000-8000-000000000001','c0b00001-0000-4000-8000-000000000001',0),
  ('c0c00002-0000-4000-8000-000000000002','c0b00002-0000-4000-8000-000000000002',0);

/*
  代理店報酬: 2026-06 / 2026-07 / 2026-08。
  2026-08 は「締めていない月」として、claim されないことを確認するためのもの。
*/
insert into public.agency_reward_items
  (agency_id, creator_id, target_month, source_row_key, order_id, product_id,
   commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate,
   reward_amount, is_reward_target, is_paid) values
  ('c0a00001-0000-4000-8000-000000000001','c0c00001-0000-4000-8000-000000000001','2026-06','ct-a-06','o1','p1',1000,1000,900,10,100,true,false),
  ('c0a00001-0000-4000-8000-000000000001','c0c00001-0000-4000-8000-000000000001','2026-07','ct-a-07','o2','p1',2000,2000,1800,10,200,true,false),
  ('c0a00001-0000-4000-8000-000000000001','c0c00001-0000-4000-8000-000000000001','2026-08','ct-a-08','o3','p1',9000,9000,8000,10,900,true,false),
  ('c0a00002-0000-4000-8000-000000000002','c0c00001-0000-4000-8000-000000000001','2026-07','ct-b-07','o4','p1',5000,5000,4500,10,500,true,false),
  ('c0a00003-0000-4000-8000-000000000003','c0c00001-0000-4000-8000-000000000001','2026-07','ct-c-07','o5','p1',7000,7000,6300,10,700,true,false);

/* 紹介報酬も同じ月構成。代理店報酬と同じ cutoff が効くことを確認する */
insert into public.referral_reward_items
  (referrer_id, creator_id, target_month, source_row_key, order_id, product_id,
   base_amount, reward_rate, original_reward_amount, adjusted_reward_amount, reward_amount,
   cap_applied, cap_reached, is_reward_target, is_paid) values
  ('c0b00001-0000-4000-8000-000000000001','c0c00001-0000-4000-8000-000000000001','2026-06','ct-r1-06','o1','p1',210,0.05,10.50,10.50,10.50,false,false,true,false),
  ('c0b00001-0000-4000-8000-000000000001','c0c00001-0000-4000-8000-000000000001','2026-07','ct-r1-07','o2','p1',405,0.05,20.25,20.25,20.25,false,false,true,false),
  ('c0b00001-0000-4000-8000-000000000001','c0c00001-0000-4000-8000-000000000001','2026-08','ct-r1-08','o3','p1',9000,0.05,450.00,450.00,450.00,false,false,true,false),
  ('c0b00002-0000-4000-8000-000000000002','c0c00002-0000-4000-8000-000000000002','2026-07','ct-r2-07','o4','p1',106,0.05,5.30,5.30,5.30,false,false,true,false),
  ('c0b00002-0000-4000-8000-000000000002','c0c00002-0000-4000-8000-000000000002','2026-08','ct-r2-08','o5','p1',2000,0.05,100.00,100.00,100.00,false,false,true,false);

-- =========================================================================
-- 異常系（cutoff の検証）
-- =========================================================================
do $blk$
declare v_err text; v_next text;
begin
  -- TEST 15: 未来月を拒否
  v_next := to_char((now() at time zone 'Asia/Tokyo')::date + interval '2 month', 'YYYY-MM');
  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001', v_next);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(15, '未来月の締め対象月を拒否', v_err like '%未来月%', v_err);

  -- TEST 16: 不正な YYYY-MM を拒否
  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001','2026-7');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(1601, '2026-7 を拒否', v_err like '%形式が不正%', v_err);

  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001','2026/07');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(1602, '2026/07 を拒否', v_err like '%形式が不正%', v_err);

  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001','abc');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(1603, 'abc を拒否', v_err like '%形式が不正%', v_err);

  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001','');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(1604, '空文字を拒否', v_err like '%形式が不正%', v_err);

  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001', null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(1605, 'null を拒否', v_err like '%形式が不正%', v_err);

  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001','2026-13');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(1606, '存在しない月(2026-13)を拒否', v_err like '%形式が不正%', v_err);

  -- 開始月が締め月より後
  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001','2026-06','2026-07');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(1607, '開始月 > 締め対象月 を拒否', v_err like '%開始月%', v_err);

  -- TEST 6: bank_missing は claim 不可（cutoff が正しくても）
  begin
    perform public.claim_payment_batch_items('agency','c0a00002-0000-4000-8000-000000000002','2026-07');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(6, 'bank_missing は claim 不可', v_err like '%振込先が未登録%', v_err);

  -- TEST 7: in_house は claim 不可
  begin
    perform public.claim_payment_batch_items('agency','c0a00003-0000-4000-8000-000000000003','2026-07');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(7, 'in_house は claim 不可', v_err like '%自社%', v_err);
end $blk$;

-- =========================================================================
-- TEST 14: 締め月を迂回する引数が存在しないこと
-- =========================================================================
do $blk$
declare v_args text; v_cnt int;
begin
  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='claim_payment_batch_items';
  perform t_check(1401, 'claim RPC のシグネチャは1つだけ（旧版が残っていない）', v_cnt = 1, format('%s 個', v_cnt));

  select pg_get_function_arguments(p.oid) into v_args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='claim_payment_batch_items';
  perform t_check(14, 'p_period_end_month で cutoff を迂回できない',
    v_args not like '%p_period_end_month%' and v_args like '%p_cutoff_month%', v_args);
end $blk$;

-- =========================================================================
-- TEST 1/2/4/5/12/17: cutoff=2026-07 で claim
-- =========================================================================
do $blk$
declare v_batch uuid; v_cnt int; v_amt numeric; v_cut text; v_end text;
begin
  v_batch := public.claim_payment_batch_items(
    'agency','c0a00001-0000-4000-8000-000000000001','2026-07','2026-01',0,'T1');

  select item_count, payment_amount, cutoff_month, period_end_month
    into v_cnt, v_amt, v_cut, v_end
    from public.payment_batches where id = v_batch;

  -- 代理店 100+200=300 / 紹介 10.50+20.25+5.30=36.05 → 5件 / 336.05
  perform t_check(1, 'cutoff=2026-07 で7月までを claim（5件 / 336.05円）',
    v_cnt = 5 and v_amt = 336.05, format('件数=%s 金額=%s', v_cnt, v_amt));

  perform t_check(2, '8月の代理店報酬は claim されない',
    (select payment_batch_id from public.agency_reward_items where source_row_key='ct-a-08') is null, null);

  perform t_check(201, '8月の紹介報酬も claim されない',
    (select count(*) from public.referral_reward_items
      where source_row_key in ('ct-r1-08','ct-r2-08') and payment_batch_id is not null) = 0, null);

  perform t_check(4, '代理店報酬と紹介報酬に同じ cutoff が効く',
    (select max(target_month) from public.agency_reward_items where payment_batch_id = v_batch) = '2026-07'
    and (select max(target_month) from public.referral_reward_items where payment_batch_id = v_batch) = '2026-07', null);

  perform t_check(5, '複数referrer → 1 agency が同じ明細に入る',
    (select count(distinct referrer_id) from public.referral_reward_items where payment_batch_id = v_batch) = 2, null);

  perform t_check(12, '支払明細に締め対象月が保存される', v_cut = '2026-07', v_cut);
  perform t_check(17, 'period_end_month = cutoff_month', v_end = v_cut, format('end=%s cutoff=%s', v_end, v_cut));

  perform t_check(13, 'CSV対象（batch集計）と claim 内容が一致',
    v_amt = (select coalesce(sum(reward_amount),0) from public.agency_reward_items where payment_batch_id = v_batch)
          + (select coalesce(sum(coalesce(adjusted_reward_amount,reward_amount,0)),0)
               from public.referral_reward_items where payment_batch_id = v_batch), null);
end $blk$;

-- =========================================================================
-- TEST 8/9/10: 既に paid / claimed / payout 済みは除外
-- =========================================================================
do $blk$
declare v_batch uuid; v_err text;
begin
  select id into v_batch from public.payment_batches
   where agency_id='c0a00001-0000-4000-8000-000000000001' and status='draft';

  -- TEST 9: 占有済みは同じ cutoff でも再claimされない
  begin
    perform public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001','2026-07');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm;
  end;
  perform t_check(9, '占有済み明細は再 claim されない', v_err like '%未払い明細がありません%', v_err);

  -- TEST 11: release すると同じ cutoff で作り直せる
  perform public.release_payment_batch_items(v_batch, 'agency');
  delete from public.payment_batches where id = v_batch;

  v_batch := public.claim_payment_batch_items('agency','c0a00001-0000-4000-8000-000000000001','2026-07');
  perform t_check(11, 'release 後に同じ cutoff で再作成できる',
    (select item_count from public.payment_batches where id = v_batch) = 5, null);

  -- TEST 3 準備: 7月分を paid にする
  perform public.approve_payment_batch(v_batch);
  perform public.complete_payment_batch(v_batch, null, 'T3準備');
  perform t_check(8, '7月分が支払済みになる',
    (select count(*) from public.agency_reward_items where payment_batch_id = v_batch and is_paid) = 2
    and (select count(*) from public.referral_reward_items where payment_batch_id = v_batch and is_paid) = 3, null);
  perform t_check(10, '支払済み明細に payout_id が付く',
    (select count(*) from public.agency_reward_items where payment_batch_id = v_batch and payout_id is null) = 0, null);
end $blk$;

-- =========================================================================
-- TEST 3: 7月paid済みのあと cutoff=2026-08 → 8月だけ
-- =========================================================================
do $blk$
declare v_batch uuid; v_cnt int; v_amt numeric; v_min text;
begin
  v_batch := public.claim_payment_batch_items(
    'agency','c0a00001-0000-4000-8000-000000000001','2026-08','2026-01',0,'T3');

  select item_count, payment_amount into v_cnt, v_amt
    from public.payment_batches where id = v_batch;

  -- 代理店 900 / 紹介 450.00 + 100.00 = 550.00 → 3件 / 1450.00
  perform t_check(3, '7月paid済みなら cutoff=2026-08 で8月だけ（3件 / 1450.00円）',
    v_cnt = 3 and v_amt = 1450.00, format('件数=%s 金額=%s', v_cnt, v_amt));

  select least(
    (select min(target_month) from public.agency_reward_items where payment_batch_id = v_batch),
    (select min(target_month) from public.referral_reward_items where payment_batch_id = v_batch)
  ) into v_min;
  perform t_check(301, '8月より前の月が混ざらない', v_min = '2026-08', v_min);

  perform t_check(302, '締め対象月が 2026-08 で保存される',
    (select cutoff_month from public.payment_batches where id = v_batch) = '2026-08', null);
end $blk$;

-- =========================================================================
-- 結果
-- =========================================================================
select count(*) "実行テスト数", count(*) filter (where ok) 成功, count(*) filter (where not ok) 失敗
from t_result;
select no, name, case when ok then 'PASS' else 'FAIL' end 結果 from t_result order by no;

rollback;
