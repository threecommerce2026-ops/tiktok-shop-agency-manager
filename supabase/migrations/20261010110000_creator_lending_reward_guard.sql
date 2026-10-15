-- =============================================================================
-- 端末貸し出し報酬のDB側ガード（本人受取版）
-- =============================================================================
/*
  ■ 2つのガードを置く

  ① creator_lending_reward_items への書き込みを検証する
     対象月の区分・所属・AK・分配率・金額が揃っていないと保存させない。

  ② agency_reward_items に端末貸し出し報酬を誤投入させない
     受取人がクリエイター本人になったので、agency_reward_items に
     reward_kind='account_lending' の行が入ることは設計上ありえない。
     20261009130000 で作ったガード関数を、この「誤投入の検知」へ差し替える。
     （20261009130000 のファイル自体は改変しない）

  ■ 検証する4条件（1つでも外れたら保存させない＝fail-closed）
     ⅰ 対象月の管理区分が account_lending
          creator_monthly_account_management_types（月別確定）
          月別確定が無い月は creators.account_management_type を見る
     ⅱ 対象月の所属が自社（agencies.is_in_house = true）
          creator_monthly_agency_assignments + agencies
     ⅲ AK（agency_split_rate）= 100
          affiliate_order_lines（source_row_key は UNIQUE なので一意に引ける）
     ⅳ 金額が AP × split_rate と一致（1銭まで許容）
          かつ 本人 + 自社 = AP

  ■ 既存の支払処理を壊さない
  金額・分配率・受取人・自社取り分が動かない UPDATE は検査しない。
  これにより次が従来どおり動く。
     claim（payment_batch_id を設定）
     complete（is_paid / paid_at を設定）
     release（payment_batch_id を解除）
     payout_id の紐付け・解除

  ■ 許容差
  1銭（0.01円）。JavaScript の浮動小数と numeric の丸め差を吸収する。
  防ぎたい事故（分配率の掛け忘れ＝AP そのまま）は 20% ずれるので通らない。

  ■ DML は 0 件
*/

-- ① 本人受取の明細を検証するガード -------------------------------------------
create or replace function public.guard_creator_lending_reward_item()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_monthly_type   text;
  v_current_type   text;
  v_effective_type text;
  v_agency_id      uuid;
  v_is_in_house    boolean;
  v_has_assignment boolean := false;
  v_ap             numeric;
  v_ak             numeric;
  v_expected       numeric;
  v_self_expected  numeric;
begin
  /*
    検査の対象になる列が1つも動かない更新は検査しない。
    支払処理（payment_batch_id / is_paid / paid_at / payout_id）はここを通る。

    ここに挙げる列は「ガードが検証に使うすべての列」でなければならない。
    1つでも漏らすと、その列だけを書き換える更新が検査を素通りする。
    ローカル検証で agency_split_rate の漏れを見つけたため、
    AK と記録した自社所属も比較対象に入れている。
  */
  if tg_op = 'UPDATE'
     and old.reward_amount      is not distinct from new.reward_amount
     and old.self_share_amount  is not distinct from new.self_share_amount
     and old.split_rate         is not distinct from new.split_rate
     and old.creator_id         is not distinct from new.creator_id
     and old.agency_revenue     is not distinct from new.agency_revenue
     and old.agency_split_rate  is not distinct from new.agency_split_rate
     and old.in_house_agency_id is not distinct from new.in_house_agency_id
     and old.target_month       is not distinct from new.target_month
     and old.source_row_key     is not distinct from new.source_row_key then
    return new;
  end if;

  -- ⅰ 対象月の管理区分 ------------------------------------------------------
  select m.account_management_type
    into v_monthly_type
    from public.creator_monthly_account_management_types m
   where m.creator_id = new.creator_id
     and m.target_month = new.target_month;

  select c.account_management_type
    into v_current_type
    from public.creators c
   where c.id = new.creator_id;

  /* 月別確定があればそれが正。無ければ現在値（既存の優先順位と同じ） */
  v_effective_type := coalesce(nullif(btrim(v_monthly_type), ''), nullif(btrim(v_current_type), ''), 'standard');

  if v_effective_type <> 'account_lending' then
    raise exception
      '対象月（%）の管理区分がアカウント貸し出しではありません（現在の区分: %）。端末貸し出し報酬を作れません',
      new.target_month, v_effective_type
      using errcode = '22023';
  end if;

  -- ⅱ 対象月の所属が自社 ---------------------------------------------------
  select ma.agency_id, coalesce(a.is_in_house, false), true
    into v_agency_id, v_is_in_house, v_has_assignment
    from public.creator_monthly_agency_assignments ma
    left join public.agencies a on a.id = ma.agency_id
   where ma.creator_id = new.creator_id
     and ma.target_month = new.target_month;

  if not coalesce(v_has_assignment, false) then
    raise exception
      '対象月（%）の所属が月別確定されていません。端末貸し出し報酬を作れません',
      new.target_month
      using errcode = '22023';
  end if;

  if not coalesce(v_is_in_house, false) then
    raise exception
      '対象月（%）の所属が自社ではありません。端末貸し出し報酬は自社所属のクリエイターだけが対象です',
      new.target_month
      using errcode = '22023';
  end if;

  /* 記録した自社所属が実際の所属と一致していること */
  if new.in_house_agency_id is not null and new.in_house_agency_id <> v_agency_id then
    raise exception
      '記録された自社所属が対象月（%）の確定所属と一致しません',
      new.target_month
      using errcode = '22023';
  end if;

  -- ⅲ AK が 100% / ⅳ 金額 --------------------------------------------------
  select ol.agency_revenue, ol.agency_split_rate
    into v_ap, v_ak
    from public.affiliate_order_lines ol
   where ol.source_row_key = new.source_row_key;

  if v_ap is null then
    raise exception
      '元の注文明細が見つからないため、端末貸し出し報酬を検証できません（対象月 % / source_row_key %）',
      new.target_month, coalesce(new.source_row_key, '(null)')
      using errcode = '22023';
  end if;

  if coalesce(v_ak, 0) <> 100 then
    raise exception
      'AK（エージェンシー分配率）が 100%% ではありません（対象月 % / AK %）。端末貸し出し報酬を作れません',
      new.target_month, coalesce(v_ak, 0)
      using errcode = '22023';
  end if;

  /*
    記録した AK が注文明細と一致していること。

    注文明細側の AK を見るだけでは、明細に記録した AK だけを書き換える
    操作を止められない（ローカル検証で素通りすることを確認した）。
    AP と同じように、記録値と正データの一致も確かめる。
  */
  if abs(coalesce(new.agency_split_rate, 0) - v_ak) > 0.0001 then
    raise exception
      '記録された AK が注文明細と一致しません（対象月 % / 注文明細 % / 保存しようとした値 %）',
      new.target_month, v_ak, coalesce(new.agency_split_rate, 0)
      using errcode = '22023';
  end if;

  if abs(new.agency_revenue - v_ap) > 0.01 then
    raise exception
      '記録された AP が注文明細と一致しません（対象月 % / 注文明細 % / 保存しようとした値 %）',
      new.target_month, v_ap, new.agency_revenue
      using errcode = '22023';
  end if;

  v_expected := round(v_ap * new.split_rate, 2);
  v_self_expected := round(v_ap - v_expected, 2);

  if abs(new.reward_amount - v_expected) > 0.01 then
    raise exception
      '本人報酬が AP × 分配率と一致しません（対象月 % / AP % × % = % / 保存しようとした値 %）',
      new.target_month, v_ap, new.split_rate, v_expected, new.reward_amount
      using errcode = '22023';
  end if;

  if abs(new.self_share_amount - v_self_expected) > 0.01 then
    raise exception
      '自社取り分が AP − 本人報酬と一致しません（対象月 % / 期待 % / 保存しようとした値 %）',
      new.target_month, v_self_expected, new.self_share_amount
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

comment on function public.guard_creator_lending_reward_item() is
  '端末貸し出し報酬の明細を検証する。対象月の区分がアカウント貸し出し / 所属が自社 / AK=100% / 本人報酬=AP×分配率 / 自社取り分=AP−本人報酬 をすべて満たさないと保存させない。金額・分配率・受取人が動かない更新（支払処理）は検査しない。';

drop trigger if exists creator_lending_reward_items_guard on public.creator_lending_reward_items;
create trigger creator_lending_reward_items_guard
  before insert or update on public.creator_lending_reward_items
  for each row
  execute function public.guard_creator_lending_reward_item();

-- ② agency_reward_items への誤投入を止める ------------------------------------
/*
  受取人が本人になったため、agency_reward_items に端末貸し出し報酬が
  入ることは設計上ありえない。20261009130000 で作った関数を
  「account_lending を入れさせない」検知へ差し替える。

  20261009120000 で追加した reward_kind / lending_split_rate 列と
  CHECK 制約はそのまま残す（誤投入の検知に使うため）。

  既存 2,124 行はすべて reward_kind='agency' / lending_split_rate=null なので
  この差し替えで止まる書き込みは無い。
*/
create or replace function public.guard_account_lending_reward_kind()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  /*
    金額・種類・分配率・受取先が動かない更新は検査しない。
    既存の支払処理（claim / complete / release / 年間支払）はここを通る。
  */
  if tg_op = 'UPDATE'
     and old.reward_amount      is not distinct from new.reward_amount
     and old.reward_kind        is not distinct from new.reward_kind
     and old.lending_split_rate is not distinct from new.lending_split_rate
     and old.agency_id          is not distinct from new.agency_id then
    return new;
  end if;

  /*
    端末貸し出し報酬は creator_lending_reward_items で管理する。
    代理店報酬の明細に入れてはいけない（受取人が代理店ではなく本人のため）。
  */
  if coalesce(new.reward_kind, 'agency') = 'account_lending' then
    raise exception
      '端末貸し出し報酬は代理店報酬の明細に保存できません。creator_lending_reward_items（本人受取）で管理してください'
      using errcode = '22023';
  end if;

  if new.lending_split_rate is not null then
    raise exception
      '代理店報酬の明細に端末貸し出しの分配率は保存できません（対象月 %）',
      new.target_month
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

comment on function public.guard_account_lending_reward_kind() is
  '代理店報酬の明細に端末貸し出し報酬（reward_kind=account_lending / 分配率あり）を入れさせない。本人受取の報酬は creator_lending_reward_items で管理する。金額・種類・分配率・受取先が動かない更新は検査しない。';

/* トリガ名は 20261009130000 で作ったものを引き続き使う（関数だけ差し替わる） */
drop trigger if exists agency_reward_items_account_lending_guard on public.agency_reward_items;
create trigger agency_reward_items_account_lending_guard
  before insert or update on public.agency_reward_items
  for each row
  execute function public.guard_account_lending_reward_kind();
