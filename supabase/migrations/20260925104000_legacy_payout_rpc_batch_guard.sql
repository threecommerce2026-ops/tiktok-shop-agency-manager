-- =============================================================================
-- 旧支払RPC に「支払明細に占有中の明細を払わない」ガードを足す
-- =============================================================================
-- ■ これは DROP migration ではない
--   旧 referral payout RPC の削除は別フェーズで行う。
--   ここでは既存関数を create or replace して WHERE 条件を1つ足すだけ。
--   関数名・引数・戻り値・権限は一切変えない。
--
-- ■ なぜ必要か
--   /revenue の「支払確定」から呼ばれる旧RPC は
--     is_reward_target / is_paid / payout_id
--   しか見ておらず、payment_batch_id を知らない。
--   支払管理（/payments）で支払明細に組み入れた明細を、旧RPC から
--   もう一度支払ってしまえる＝二重支払いの経路が残る。
--
--   旧RPC はいますぐ消さない方針なので、経路そのものを塞ぐ。
--   占有中の明細は旧RPC からは見えなくなる。
--
-- ■ 変更点は1箇所だけ
--   集計・更新の WHERE に
--     and payment_batch_id is null
--   を追加する。金額の計算式・対象条件・しきい値判定は変更しない。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 代理店（年間累積）
-- -----------------------------------------------------------------------------
create or replace function public.mark_agency_payout_paid_annual(
  p_payout_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout public.agency_payouts%rowtype;
  v_year text;
  v_total numeric := 0;
  v_paid_at timestamptz := now();
begin
  if not public.is_app_admin() then
    raise exception '管理者権限が必要です';
  end if;

  select *
  into v_payout
  from public.agency_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception '支払いレコードが見つかりません';
  end if;

  if v_payout.status = 'paid' then
    return;
  end if;

  v_year := left(v_payout.target_month, 4);

  select coalesce(sum(reward_amount), 0)
  into v_total
  from public.agency_reward_items
  where agency_id = v_payout.agency_id
    and left(target_month, 4) = v_year
    and target_month <= v_payout.target_month
    and is_reward_target = true
    and is_paid = false
    and payout_id is null
    -- 支払管理の支払明細に組み入れ済みの明細は対象外（二重支払い防止）
    and payment_batch_id is null;

  if v_total <= 0 then
    raise exception '支払対象の未払い明細がありません';
  end if;

  if v_total < v_payout.threshold_amount then
    raise exception '年間未払い累積が支払基準額に達していません（現在 % 円）', v_total;
  end if;

  update public.agency_reward_items
  set
    payout_id = p_payout_id,
    is_paid = true,
    paid_at = v_paid_at,
    updated_at = v_paid_at
  where agency_id = v_payout.agency_id
    and left(target_month, 4) = v_year
    and target_month <= v_payout.target_month
    and is_reward_target = true
    and is_paid = false
    and payout_id is null
    and payment_batch_id is null;

  update public.agency_payouts
  set
    total_reward_amount = v_total,
    is_payable = true,
    status = 'paid',
    paid_at = v_paid_at,
    updated_at = v_paid_at
  where id = p_payout_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. 紹介者（年間累積）
-- -----------------------------------------------------------------------------
create or replace function public.mark_referral_payout_paid_annual(
  p_payout_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout public.referral_payouts%rowtype;
  v_year text;
  v_total numeric := 0;
  v_paid_at timestamptz := now();
  v_pair record;
begin
  if not public.is_app_admin() then
    raise exception '管理者権限が必要です';
  end if;

  select *
  into v_payout
  from public.referral_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception '支払いレコードが見つかりません';
  end if;

  if v_payout.status = 'paid' then
    return;
  end if;

  v_year := left(v_payout.target_month, 4);

  select coalesce(sum(coalesce(adjusted_reward_amount, reward_amount, 0)), 0)
  into v_total
  from public.referral_reward_items
  where referrer_id = v_payout.referrer_id
    and left(target_month, 4) = v_year
    and target_month <= v_payout.target_month
    and is_reward_target = true
    and is_paid = false
    and payout_id is null
    and payment_batch_id is null;

  if v_total < v_payout.threshold_amount then
    raise exception '年間未払い累積が支払基準額に達していません（現在 % 円）', v_total;
  end if;

  update public.referral_reward_items
  set
    payout_id = p_payout_id,
    is_paid = true,
    paid_at = v_paid_at,
    updated_at = v_paid_at
  where referrer_id = v_payout.referrer_id
    and left(target_month, 4) = v_year
    and target_month <= v_payout.target_month
    and is_reward_target = true
    and is_paid = false
    and payout_id is null
    and payment_batch_id is null;

  for v_pair in
    select
      creator_id,
      referrer_id,
      sum(coalesce(adjusted_reward_amount, reward_amount, 0)) as amount
    from public.referral_reward_items
    where payout_id = p_payout_id
      and is_paid = true
    group by creator_id, referrer_id
  loop
    update public.creator_referrals
    set
      lifetime_paid_amount = coalesce(lifetime_paid_amount, 0) + v_pair.amount,
      updated_at = v_paid_at
    where id = (
      select cr.id
      from public.creator_referrals cr
      where cr.creator_id = v_pair.creator_id
        and cr.referrer_id = v_pair.referrer_id
      order by cr.created_at desc
      limit 1
    );
  end loop;

  update public.referral_payouts
  set
    total_reward_amount = v_total,
    is_payable = true,
    status = 'paid',
    paid_at = v_paid_at,
    updated_at = v_paid_at
  where id = p_payout_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. 紹介者（年度スコープ無しの最旧版）
-- -----------------------------------------------------------------------------
-- コードからの呼び出しは無いが、DB に残っていて直接実行できてしまうため
-- 同じガードを入れておく。
create or replace function public.mark_referral_payout_paid(
  p_payout_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout public.referral_payouts%rowtype;
  v_total numeric := 0;
  v_paid_at timestamptz := now();
  v_pair record;
begin
  if not public.is_app_admin() then
    raise exception '管理者権限が必要です';
  end if;

  select *
  into v_payout
  from public.referral_payouts
  where id = p_payout_id
  for update;

  if not found then
    raise exception '支払いレコードが見つかりません';
  end if;

  if v_payout.status = 'paid' then
    return;
  end if;

  select coalesce(
    sum(coalesce(adjusted_reward_amount, reward_amount, 0)),
    0
  )
  into v_total
  from public.referral_reward_items
  where referrer_id = v_payout.referrer_id
    and target_month <= v_payout.target_month
    and is_reward_target = true
    and is_paid = false
    and payout_id is null
    and payment_batch_id is null;

  if v_total < v_payout.threshold_amount then
    raise exception '支払条件に達していません';
  end if;

  update public.referral_reward_items
  set
    payout_id = p_payout_id,
    is_paid = true,
    paid_at = v_paid_at,
    updated_at = v_paid_at
  where referrer_id = v_payout.referrer_id
    and target_month <= v_payout.target_month
    and is_reward_target = true
    and is_paid = false
    and payout_id is null
    and payment_batch_id is null;

  for v_pair in
    select
      creator_id,
      referrer_id,
      sum(coalesce(adjusted_reward_amount, reward_amount, 0)) as amount
    from public.referral_reward_items
    where payout_id = p_payout_id
      and is_paid = true
    group by creator_id, referrer_id
  loop
    update public.creator_referrals
    set
      lifetime_paid_amount =
        coalesce(lifetime_paid_amount, 0) + v_pair.amount,
      updated_at = v_paid_at
    where id = (
      select cr.id
      from public.creator_referrals cr
      where cr.creator_id = v_pair.creator_id
        and cr.referrer_id = v_pair.referrer_id
      order by cr.created_at desc
      limit 1
    );
  end loop;

  update public.referral_payouts
  set
    total_reward_amount = v_total,
    is_payable = true,
    status = 'paid',
    paid_at = v_paid_at,
    updated_at = v_paid_at
  where id = p_payout_id;
end;
$$;

-- 権限は既存のまま（revoke / grant を新たに行わない）
