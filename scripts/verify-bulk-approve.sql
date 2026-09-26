/*
  支払明細の一括承認の検証（使い捨てDB専用）。

  ■ 本番では実行しない
  実データを INSERT / UPDATE する。scratch DB に本番スキーマの最小再現と
  migration を適用したうえで実行する。

    psql -d bulkapp -f scripts/verify-bulk-approve.sql

  ■ 何を守っているか
  ・1件でも検証に失敗したら全件ロールバックする（部分承認しない）
  ・承認できるのは draft だけ。二重押下で二重承認しない
  ・振込先の必須項目は単体承認と同じ
  ・代理店へ紹介制度報酬は支払わない（占有があれば承認を止める）
  ・締め対象月が混在したら承認しない
  ・承認時に振込先が固定され、以後マスタ変更の影響を受けない
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
  ('55555555-5555-4555-8555-555555555555', 'bulk-approve@example.local');
set test.uid = '55555555-5555-4555-8555-555555555555';

/* A1〜A3 = 口座完備 / A4 = 口座なし / A5 = 支店コードだけ欠け / A6 = 自社 */
insert into public.agencies (id, name, is_in_house, bank_name, bank_code,
       bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder) values
  ('f0a00001-0000-4000-8000-000000000001','BA_Full1', false,'テスト銀行','0001','本店','001','普通','1111111','ﾃｽﾄ1'),
  ('f0a00002-0000-4000-8000-000000000002','BA_Full2', false,'テスト銀行','0002','二号店','002','普通','2222222','ﾃｽﾄ2'),
  ('f0a00003-0000-4000-8000-000000000003','BA_Full3', false,'テスト銀行','0003','三号店','003','当座','3333333','ﾃｽﾄ3'),
  ('f0a00004-0000-4000-8000-000000000004','BA_NoBank',false,null,null,null,null,null,null,null),
  ('f0a00005-0000-4000-8000-000000000005','BA_Partial',false,'テスト銀行','0005','五号店',null,'普通','5555555','ﾃｽﾄ5');

insert into public.referrers (id, name, referrer_name, referral_code, agency_id, is_in_house,
       bank_name, bank_code, bank_branch_name, bank_branch_code, bank_account_type, bank_account_number, bank_account_holder) values
  ('f0b00001-0000-4000-8000-000000000001','BA_Ref','BA_Ref','BAR',null,false,
   'テスト銀行','0009','九号店','009','普通','9999999','ﾃｽﾄ9');

insert into public.creators (id) values ('f0c00001-0000-4000-8000-000000000001');

/* 各代理店に 2026-07 の代理店分配報酬を作る */
insert into public.agency_reward_items
  (agency_id, creator_id, target_month, source_row_key, order_id, product_id,
   commission_base, commission_gmv, creator_revenue_before_split, agency_split_rate,
   reward_amount, is_reward_target, is_paid)
select a.id, 'f0c00001-0000-4000-8000-000000000001', '2026-07',
       'ba-' || a.name, 'o-' || a.name, 'p1', 10000, 10000, 9000, 10,
       amt, true, false
from (values
  -- 金額はいずれも最低支払額（¥1,000）以上にする。未満だと承認できない
  ('f0a00001-0000-4000-8000-000000000001'::uuid, 8000::numeric),
  ('f0a00002-0000-4000-8000-000000000002', 2000),
  ('f0a00003-0000-4000-8000-000000000003', 1000),
  ('f0a00004-0000-4000-8000-000000000004', 4000),
  ('f0a00005-0000-4000-8000-000000000005', 3000)
) v(aid, amt)
join public.agencies a on a.id = v.aid;

/* 紹介制度報酬（代理店へは支払わない）*/
insert into public.referral_reward_items
  (referrer_id, creator_id, target_month, source_row_key, order_id, product_id,
   base_amount, reward_rate, original_reward_amount, adjusted_reward_amount, reward_amount,
   cap_applied, cap_reached, is_reward_target, is_paid) values
  ('f0b00001-0000-4000-8000-000000000001','f0c00001-0000-4000-8000-000000000001','2026-07',
   'ba-r1','o1','p1',2000,0.05,100,100,100,false,false,true,false);

-- 口座完備の3社ぶんの draft を作る
do $blk$
declare v_b1 uuid; v_b2 uuid; v_b3 uuid;
begin
  v_b1 := public.claim_payment_batch_items('agency','f0a00001-0000-4000-8000-000000000001','2026-07');
  v_b2 := public.claim_payment_batch_items('agency','f0a00002-0000-4000-8000-000000000002','2026-07');
  v_b3 := public.claim_payment_batch_items('agency','f0a00003-0000-4000-8000-000000000003','2026-07');
  perform set_config('test.b1', v_b1::text, false);
  perform set_config('test.b2', v_b2::text, false);
  perform set_config('test.b3', v_b3::text, false);
end $blk$;

-- =========================================================================
-- TEST 3〜5, 13, 19〜20: 入力検証
-- =========================================================================
do $blk$
declare v_err text; v_ids uuid[];
begin
  -- TEST 3: 空配列
  begin
    perform public.approve_payment_batches_bulk(array[]::uuid[]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(3, '空配列を拒否', v_err like '%1件以上選択%', v_err);

  -- null
  begin
    perform public.approve_payment_batches_bulk(null);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(301, 'null を拒否', v_err like '%指定してください%', v_err);

  -- NULL だけの配列
  begin
    perform public.approve_payment_batches_bulk(array[null]::uuid[]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(302, 'NULL だけの配列を拒否', v_err like '%1件以上選択%', v_err);

  -- TEST 5: 存在しない batch
  begin
    perform public.approve_payment_batches_bulk(
      array['00000000-0000-4000-8000-0000000000ff']::uuid[]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(5, '存在しない支払明細を拒否', v_err like '%存在しない支払明細%', v_err);

  -- TEST 20: 101件で上限超過
  select array_agg(gen_random_uuid()) into v_ids from generate_series(1,101);
  begin
    perform public.approve_payment_batches_bulk(v_ids);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(20, '101件は上限超過で拒否', v_err like '%100 件までです%', v_err);

  -- TEST 19: 100件までは上限チェックを通過する（存在確認で落ちる＝上限ではない）
  select array_agg(gen_random_uuid()) into v_ids from generate_series(1,100);
  begin
    perform public.approve_payment_batches_bulk(v_ids);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(19, '100件は上限で弾かれない', v_err like '%存在しない支払明細%', v_err);
end $blk$;

-- =========================================================================
-- TEST 4: 重複 batch id は1件として扱う
-- =========================================================================
do $blk$
declare v_b1 uuid := current_setting('test.b1')::uuid; v_n int;
begin
  v_n := public.approve_payment_batches_bulk(array[v_b1, v_b1, v_b1]);
  perform t_check(4, '重複した支払明細IDは1件として承認される', v_n = 1, format('承認=%s', v_n));
  perform t_check(401, '監査ログは1件だけ',
    (select count(*) from public.payment_batch_audit_logs
      where batch_id = v_b1 and action = 'approved') = 1, null);

  -- TEST 18: 二重送信しても2回目は承認されない
  perform t_check(18, '二重送信は draft でないため拒否される',
    (select status from public.payment_batches where id = v_b1) = 'approved', null);
end $blk$;

do $blk$
declare v_b1 uuid := current_setting('test.b1')::uuid; v_err text;
begin
  begin
    perform public.approve_payment_batches_bulk(array[v_b1]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(1801, '承認済みを再承認できない', v_err like '%下書きの支払明細だけ%', v_err);
  perform t_check(1802, '監査ログが増えない',
    (select count(*) from public.payment_batch_audit_logs
      where batch_id = v_b1 and action = 'approved') = 1, null);
end $blk$;

-- =========================================================================
-- TEST 6: draft 以外が混ざると全件失敗
-- =========================================================================
do $blk$
declare v_b1 uuid := current_setting('test.b1')::uuid;
        v_b2 uuid := current_setting('test.b2')::uuid;
        v_err text;
begin
  begin
    perform public.approve_payment_batches_bulk(array[v_b2, v_b1]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(6, 'draft以外が混ざると失敗', v_err like '%下書きの支払明細だけ%', v_err);

  -- TEST 14: 1件失敗で全ロールバック（b2 は承認されていない）
  perform t_check(14, '1件失敗なら他も承認されない（全ロールバック）',
    (select status from public.payment_batches where id = v_b2) = 'draft', null);
end $blk$;

-- =========================================================================
-- TEST 8/9: 振込先の不足
-- =========================================================================
do $blk$
declare v_b uuid; v_err text;
begin
  -- TEST 8: 口座なし → claim 自体ができない（承認前に止まる）
  begin
    perform public.claim_payment_batch_items('agency','f0a00004-0000-4000-8000-000000000004','2026-07');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(8, '口座未登録の代理店は支払明細を作れない', v_err like '%振込先が未登録%', v_err);

  -- TEST 9: 支店コードだけ欠け → claim も止まる
  begin
    perform public.claim_payment_batch_items('agency','f0a00005-0000-4000-8000-000000000005','2026-07');
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(9, '支店コード未登録の代理店は支払明細を作れない',
    v_err like '%支店コードが未登録%', v_err);

  /*
    承認直前に口座が欠けた場合も止まること。
    draft を作ったあとにマスタ側の口座を消して承認を試す。
  */
  v_b := current_setting('test.b3')::uuid;
  update public.agencies set bank_branch_code = null
   where id = 'f0a00003-0000-4000-8000-000000000003';
  begin
    perform public.approve_payment_batches_bulk(array[v_b]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(901, '承認直前に振込先が欠けていたら承認しない',
    v_err like '%振込先が不足%', v_err);
  perform t_check(902, '失敗した明細は draft のまま',
    (select status from public.payment_batches where id = v_b) = 'draft', null);

  -- 元に戻す
  update public.agencies set bank_branch_code = '003'
   where id = 'f0a00003-0000-4000-8000-000000000003';
end $blk$;

-- =========================================================================
-- TEST 11/12: 金額不一致 / 紹介制度報酬の混入
-- =========================================================================
do $blk$
declare v_b uuid := current_setting('test.b2')::uuid; v_err text; v_amt numeric;
begin
  -- TEST 11: スナップショットの金額を改ざんして承認を試す
  select payment_amount into v_amt from public.payment_batches where id = v_b;
  -- 最低支払額は満たしたまま、明細合計とだけずらす
  update public.payment_batches set payment_amount = v_amt + 1 where id = v_b;
  begin
    perform public.approve_payment_batches_bulk(array[v_b]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(11, '明細合計と支払明細の金額がずれていたら承認しない',
    v_err like '%金額が支払明細と一致しません%', v_err);
  update public.payment_batches set payment_amount = v_amt where id = v_b;

  -- 件数のずれ
  update public.payment_batches set item_count = item_count + 1 where id = v_b;
  begin
    perform public.approve_payment_batches_bulk(array[v_b]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(1101, '明細件数がずれていたら承認しない',
    v_err like '%明細件数が支払明細と一致しません%', v_err);
  update public.payment_batches set item_count = item_count - 1 where id = v_b;

  -- TEST 12: 紹介制度報酬が占有されていたら承認しない（旧仕様の明細を守る）
  update public.referral_reward_items set payment_batch_id = v_b where source_row_key = 'ba-r1';
  begin
    perform public.approve_payment_batches_bulk(array[v_b]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(12, '紹介制度報酬を含む支払明細は承認しない',
    v_err like '%紹介制度報酬が%件含まれています%', v_err);
  update public.referral_reward_items set payment_batch_id = null where source_row_key = 'ba-r1';

  -- TEST 10: 対象明細が無い支払明細
  update public.agency_reward_items set payment_batch_id = null where payment_batch_id = v_b;
  begin
    perform public.approve_payment_batches_bulk(array[v_b]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(10, '対象明細が無い支払明細は承認しない',
    v_err like '%対象明細がありません%', v_err);
  update public.agency_reward_items set payment_batch_id = v_b where source_row_key = 'ba-BA_Full2';
end $blk$;

-- =========================================================================
-- 最低支払額（¥1,000）未満は承認できない
-- =========================================================================
do $blk$
declare v_b uuid := current_setting('test.b2')::uuid; v_err text; v_amt numeric;
begin
  select payment_amount into v_amt from public.payment_batches where id = v_b;
  update public.payment_batches set payment_amount = 800 where id = v_b;
  begin
    perform public.approve_payment_batches_bulk(array[v_b]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(2801, '最低支払額未満の支払明細は一括承認できない',
    v_err like '%最低支払額に達していない%', v_err);
  perform t_check(2802, '拒否された支払明細は draft のまま',
    (select status from public.payment_batches where id = v_b) = 'draft', null);
  update public.payment_batches set payment_amount = v_amt where id = v_b;
end $blk$;

-- =========================================================================
-- TEST 13: 締め対象月の混在
-- =========================================================================
do $blk$
declare v_b2 uuid := current_setting('test.b2')::uuid;
        v_b3 uuid := current_setting('test.b3')::uuid;
        v_err text;
begin
  update public.payment_batches
     set cutoff_month = '2026-06', period_end_month = '2026-06'
   where id = v_b3;
  begin
    perform public.approve_payment_batches_bulk(array[v_b2, v_b3]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(13, '締め対象月が異なる支払明細は同時に承認できない',
    v_err like '%締め対象月が異なる%', v_err);
  perform t_check(1301, '混在で失敗したとき両方 draft のまま',
    (select count(*) from public.payment_batches
      where id in (v_b2, v_b3) and status = 'draft') = 2, null);

  update public.payment_batches
     set cutoff_month = '2026-07', period_end_month = '2026-07'
   where id = v_b3;
end $blk$;

-- =========================================================================
-- TEST 1/2/15/16/17: 正常系の一括承認
-- =========================================================================
do $blk$
declare v_b2 uuid := current_setting('test.b2')::uuid;
        v_b3 uuid := current_setting('test.b3')::uuid;
        v_n int; v_amt numeric;
begin
  v_n := public.approve_payment_batches_bulk(array[v_b2, v_b3]);
  perform t_check(2, '複数件を一括承認できる', v_n = 2, format('承認=%s', v_n));

  perform t_check(1, '1件でも一括承認の入口で承認できる（TEST 4 で確認済み）',
    (select count(*) from public.payment_batches where status='approved') = 3, null);

  -- TEST 16: approved_at
  perform t_check(16, '承認した明細に approved_at が入る',
    (select count(*) from public.payment_batches
      where id in (v_b2, v_b3) and approved_at is not null) = 2, null);

  perform t_check(1601, 'approved_by に実行者が入る',
    (select count(*) from public.payment_batches
      where id in (v_b2, v_b3)
        and approved_by = '55555555-5555-4555-8555-555555555555') = 2, null);

  -- TEST 15: bank snapshot
  perform t_check(15, '承認時の振込先が支払明細へ固定される',
    (select bank_name || '/' || bank_code || '/' || bank_branch_name || '/' ||
            bank_branch_code || '/' || bank_account_type || '/' ||
            bank_account_number || '/' || bank_account_holder
       from public.payment_batches where id = v_b3)
    = 'テスト銀行/0003/三号店/003/当座/3333333/ﾃｽﾄ3', null);

  -- TEST 17: 監査ログは batch ごとに1件
  perform t_check(17, '監査ログは支払明細ごとに1件',
    (select count(*) from public.payment_batch_audit_logs
      where batch_id in (v_b2, v_b3) and action = 'approved') = 2, null);

  perform t_check(1701, '監査ログに件数と金額が残る',
    (select count(*) from public.payment_batch_audit_logs l
      join public.payment_batches b on b.id = l.batch_id
      where l.batch_id in (v_b2, v_b3) and l.action='approved'
        and l.item_count = b.item_count
        and abs(l.amount - b.payment_amount) <= 0.005) = 2, null);
end $blk$;

-- =========================================================================
-- snapshot の独立性 / 支払状態
-- =========================================================================
do $blk$
declare v_b3 uuid := current_setting('test.b3')::uuid;
begin
  -- 承認後にマスタの口座を変えても支払明細の振込先は変わらない
  update public.agencies set bank_account_number = '0000000'
   where id = 'f0a00003-0000-4000-8000-000000000003';

  perform t_check(1501, '承認後にマスタの口座を変えても支払明細の振込先は不変',
    (select bank_account_number from public.payment_batches where id = v_b3) = '3333333', null);

  -- TEST 24/25: 承認は支払済みにしない
  perform t_check(24, '承認しても is_paid は変わらない',
    (select count(*) from public.agency_reward_items where is_paid) = 0
    and (select count(*) from public.referral_reward_items where is_paid) = 0, null);

  perform t_check(25, '承認しても payout_id は付かない',
    (select count(*) from public.agency_reward_items where payout_id is not null) = 0
    and (select count(*) from public.referral_reward_items where payout_id is not null) = 0, null);

  perform t_check(2501, '紹介制度報酬は占有も支払もされていない',
    (select count(*) from public.referral_reward_items
      where payment_batch_id is null and not is_paid and payout_id is null) = 1, null);
end $blk$;

-- =========================================================================
-- 単体承認の回帰
-- =========================================================================
do $blk$
declare v_b uuid; v_err text;
begin
  -- 単体承認の入口も同じ共通処理を通る
  v_b := public.claim_payment_batch_items('agency','f0a00001-0000-4000-8000-000000000001','2026-07');
  perform t_check(2601, '単体承認の前提: 新しい draft が作れない（明細を使い切っている）',
    false, '想定外に claim できた');
exception when others then
  -- 明細を使い切っているので claim できないのが正しい
  perform t_check(2601, '占有済みなので新しい draft は作れない',
    sqlerrm like '%未払い明細がありません%', sqlerrm);
end $blk$;

do $blk$
declare v_err text;
begin
  -- 管理者でなければ一括承認できない
  perform set_config('test.is_admin', 'false', true);
  begin
    perform public.approve_payment_batches_bulk(array[gen_random_uuid()]);
    v_err := '(例外が出なかった)';
  exception when others then v_err := sqlerrm; end;
  perform t_check(2701, '管理者以外は一括承認できない', v_err like '%親管理者のみ%', v_err);
  perform set_config('test.is_admin', 'true', true);
end $blk$;

-- =========================================================================
-- 結果
-- =========================================================================
select count(*) "実行テスト数", count(*) filter (where ok) 成功, count(*) filter (where not ok) 失敗
from t_result;
select no, name, case when ok then 'PASS' else 'FAIL' end 結果 from t_result order by no;

rollback;
