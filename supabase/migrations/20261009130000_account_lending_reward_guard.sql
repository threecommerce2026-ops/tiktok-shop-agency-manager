-- =============================================================================
-- 端末貸し出し報酬のDB側ガード
-- =============================================================================
/*
  ■ 防ぐ事故
  区分 account_management_type = 'account_lending' のクリエイターの
  月別所属を貸し出し先へ変えた時点で、まだ旧エンジンが動いていると
  AP を 100% 支払う明細が作られる。

  実測（ローカル）で確認した事故の形：
    区分 account_lending / 月別所属 外部代理店 の状態で
    旧コード相当の INSERT が AP 100%（例 ¥500）で通ってしまう。
    正しくは AP × 分配率（¥400）。

  アプリ側の実装順序（migration → デプロイ → 所属変更）に頼らず、
  DB で止める。C-3b（支払対象外の紹介者を支払済にできないトリガ）と同じ考え方。

  ■ 検査する3つのこと
  対象月の確定区分が account_lending の明細について、

    ① 種類が account_lending であること
       旧コードは reward_kind を送らないので既定値 'agency' が入る。
       これを弾くことで AP 100% の保存を止める。

    ② 分配先が対象月の確定所属と一致すること
       creator_monthly_agency_assignments に行があり、その agency_id と
       明細の agency_id が同じでなければならない。
       「どこへ分配するか」は収益の帰属そのものなので、
       暫定の現在所属で支払予定を作らせない。

    ③ 金額が AP × 分配率と一致すること
       affiliate_order_lines.source_row_key は UNIQUE なので、
       明細から元の AP を一意に引ける（本番 2,124 件すべてで引けることを確認）。
       AP 100%（分配率を掛け忘れた金額）はここでも落ちる。

  ■ 既存の支払処理を壊さないための設計
  金額・種類・分配先が動かない UPDATE は検査しない。
  これにより次の既存処理は従来どおり動く（本番同等 2,124 行で実測）。

    claim_payment_batch_items    payment_batch_id を設定
    complete_payment_batch       is_paid / paid_at を設定
    release_payment_batch_items  payment_batch_id を解除
    mark_agency_payout_paid_annual / unpaid_annual  payout_id / is_paid

  最初に作った案（すべての UPDATE を検査する版）は、区分を
  account_lending に変える前に作られていた明細を支払済にすることすら
  できなくなっていた。その欠陥を直したのがこの版。

  ■ 検査しない場合
    ・対象月の区分が月別確定されていない        → 従来どおり
    ・対象月の確定区分が account_lending 以外    → 従来どおり
    ・DELETE                                     → トリガ対象外
    ・金額・種類・分配先が動かない UPDATE        → 従来どおり

  ■ 金額比較の許容差
  1銭（0.01円）まで許容する。
  アプリは JavaScript の浮動小数で AP × 分配率を計算し、DB は numeric で
  計算するため、端数の丸めが1銭ずれることがある。
  一方で防ぎたい事故（AP 100%）は 20% ずれるので、この許容差では通らない。

  ■ 元の注文行が引けない場合も拒否する
  当初は「AP が引けないときは金額検査を飛ばす」設計にしたが、
  それでは注文行の無い source_row_key に任意の金額を保存できてしまう
  （ローカルで実際に通ることを確認した）。

  注文行を消す経路が無いことを確認したうえで、拒否に変えた。
    ・アプリからの .delete(): 0 件（取込は source_row_key での upsert のみ）
    ・DB 関数内の delete / truncate: 0 件
    ・migration 内の delete / truncate: 0 件
    ・本番の孤立明細（注文行が無い明細）: 0 件 / 2,124 件中

  端末貸し出し報酬は必ず AP から計算するので、AP が引けない明細は
  そもそも作れてはいけない。金額の根拠が無いまま保存させない。

  ■ DML は 0 件
  既存データは1行も書き換えない。関数1本とトリガ1本を追加するだけ。

  ■ 適用順序
  20261009120000（reward_kind / lending_split_rate 列の追加）が先。
  このガードは列を参照するため、列が無い状態では作れない。
*/

create or replace function public.guard_account_lending_reward_kind()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_monthly_type   text;
  v_monthly_agency uuid;
  v_has_assignment boolean;
  v_ap             numeric;
  v_expected       numeric;
begin
  /*
    金額・種類・分配先が動かない更新は検査しない。
    支払処理（payment_batch_id / is_paid / paid_at / payout_id）はここを通る。
  */
  if tg_op = 'UPDATE'
     and old.reward_amount       is not distinct from new.reward_amount
     and old.reward_kind         is not distinct from new.reward_kind
     and old.lending_split_rate  is not distinct from new.lending_split_rate
     and old.agency_id           is not distinct from new.agency_id then
    return new;
  end if;

  select m.account_management_type
    into v_monthly_type
    from public.creator_monthly_account_management_types m
   where m.creator_id = new.creator_id
     and m.target_month = new.target_month;

  /* 月別確定が無い、または貸出でない月は従来どおり */
  if v_monthly_type is distinct from 'account_lending' then
    return new;
  end if;

  -- ① 種類 ------------------------------------------------------------------
  if coalesce(new.reward_kind, 'agency') <> 'account_lending' then
    raise exception
      '対象月（%）の区分がアカウント貸出のため、通常の代理店報酬として保存できません。端末貸し出し報酬（AP × 分配率）として計算してください',
      new.target_month
      using errcode = '22023';
  end if;

  if new.lending_split_rate is null then
    raise exception
      '端末貸し出し報酬には適用した分配率が必要です（対象月 %）',
      new.target_month
      using errcode = '22023';
  end if;

  if new.lending_split_rate <= 0 or new.lending_split_rate > 1 then
    raise exception
      '分配率が範囲外です（対象月 % / 値 %）。0 より大きく 1 以下で指定してください',
      new.target_month, new.lending_split_rate
      using errcode = '22023';
  end if;

  -- ② 分配先 ----------------------------------------------------------------
  select m.agency_id, true
    into v_monthly_agency, v_has_assignment
    from public.creator_monthly_agency_assignments m
   where m.creator_id = new.creator_id
     and m.target_month = new.target_month;

  if not coalesce(v_has_assignment, false) then
    raise exception
      '対象月（%）の所属が月別確定されていないため、端末貸し出し報酬を作れません。先に貸し出し先を月別確定してください',
      new.target_month
      using errcode = '22023';
  end if;

  if v_monthly_agency is null or v_monthly_agency <> new.agency_id then
    raise exception
      '端末貸し出し報酬の分配先が対象月（%）の確定所属と一致しません',
      new.target_month
      using errcode = '22023';
  end if;

  -- ③ 金額 ------------------------------------------------------------------
  select ol.agency_revenue
    into v_ap
    from public.affiliate_order_lines ol
   where ol.source_row_key = new.source_row_key;

  if v_ap is null then
    raise exception
      '元の注文明細が見つからないため、端末貸し出し報酬の金額を検証できません（対象月 % / source_row_key %）',
      new.target_month, coalesce(new.source_row_key, '(null)')
      using errcode = '22023';
  end if;

  v_expected := round(v_ap * new.lending_split_rate, 2);

  if abs(new.reward_amount - v_expected) > 0.01 then
    raise exception
      '端末貸し出し報酬の金額が AP × 分配率と一致しません（対象月 % / AP % × % = % / 保存しようとした値 %）',
      new.target_month, v_ap, new.lending_split_rate, v_expected, new.reward_amount
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

comment on function public.guard_account_lending_reward_kind() is
  '区分がアカウント貸出の月について、明細の種類・分配先・金額（AP × 分配率）を検査する。金額・種類・分配先が動かない更新（支払処理）は検査しない。';

drop trigger if exists agency_reward_items_account_lending_guard on public.agency_reward_items;
create trigger agency_reward_items_account_lending_guard
  before insert or update on public.agency_reward_items
  for each row
  execute function public.guard_account_lending_reward_kind();
