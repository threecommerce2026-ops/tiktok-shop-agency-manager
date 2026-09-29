/*
  紹介者報酬の月次確定（finalize / unfinalize）。

  ■ なぜ必要か
  referral_month_settlements は claim の前提条件として作られたが、
  読み取りガード（assert_referral_months_finalized）しか無く、
  status を finalized にする正式な経路が存在しなかった。
  そのため紹介者への支払が永久に開始できない状態だった。

  ■ 直接 UPDATE させない
  このテーブルは authenticated / service_role に SELECT も
  UPDATE も grant されていない（RLS ポリシーはあるが grant が無い）。
  読み書きとも security definer の関数だけを入口にする。
  画面やサーバーアクションがテーブルを直接触ることはない。

  ■ 月をハードコードしない
  「2026-08 以降は確定できない」といった固定は入れない。
  2026-08 が今確定できないのは TAP の全量取込が終わっていないからで、
  月そのものの性質ではない。将来 08・09・10 も同じ関数で確定する。

  対象は「settlement の行が既にある月」だけに自然に限られる。
  行が無い月は assert_referral_months_finalized が未確定として扱うので、
  ここで勝手に INSERT もしない（確定対象を静かに増やさないため）。

  ■ 監査証跡
  finalized_at と finalized_by を必ず残す。auth.uid() が取れない実行
  （service role 直叩きなど）は拒否する。誰が確定したか分からないまま
  支払の前提条件が満たされる抜け道を作らない。
  payment_batch_audit_logs は batch_id が必須なので流用できない。
  新しい監査テーブルは作らず、この2列で追跡する。
*/

-- -----------------------------------------------------------------------------
-- 一覧（画面表示用）
-- -----------------------------------------------------------------------------
/*
  月・状態・確定者に加えて、その月の紹介報酬の件数と金額も返す。

  画面は「2026年7月 / 2,011件 / 10,517.50円 を確定します」と出してから
  確定させる。月だけを見せて押させると、誤った月を確定しても気づけない。

  金額は referral_reward_items が唯一の正。ここで率を掛け直さない。
*/
create or replace function public.list_referral_month_settlements()
returns table (
  target_month text,
  status text,
  note text,
  finalized_at timestamptz,
  finalized_by uuid,
  finalized_by_email text,
  reward_item_count integer,
  reward_amount numeric,
  referrer_count integer,
  /* 支払処理へ進んだ明細。確定解除できるかの判断に使う */
  claimed_item_count integer,
  paid_item_count integer
)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    s.target_month,
    s.status,
    s.note,
    s.finalized_at,
    s.finalized_by,
    (select u.email::text from auth.users u where u.id = s.finalized_by),
    coalesce(r.item_count, 0)::integer,
    coalesce(r.reward_amount, 0)::numeric,
    coalesce(r.referrer_count, 0)::integer,
    coalesce(r.claimed_count, 0)::integer,
    coalesce(r.paid_count, 0)::integer
  from public.referral_month_settlements s
  left join lateral (
    select
      count(*) as item_count,
      sum(coalesce(i.adjusted_reward_amount, i.reward_amount, 0)) as reward_amount,
      count(distinct i.referrer_id) as referrer_count,
      count(*) filter (where i.payment_batch_id is not null or i.payout_id is not null) as claimed_count,
      count(*) filter (where i.is_paid) as paid_count
    from public.referral_reward_items i
    where i.target_month = s.target_month
  ) r on true
  where public.is_app_admin()
  order by s.target_month;
$fn$;

revoke all on function public.list_referral_month_settlements() from public, anon;
grant execute on function public.list_referral_month_settlements() to authenticated;

comment on function public.list_referral_month_settlements() is
  '紹介者報酬の月次確定状況を、その月の報酬件数・金額つきで返す。親管理者のみ。';

-- -----------------------------------------------------------------------------
-- 確定
-- -----------------------------------------------------------------------------
/*
  対象の1か月だけを finalized にする。

  すでに finalized の月は何も書き換えず、already_finalized = true で返す。
  月順に流す運用で途中から再実行しても、先に確定した月の
  finalized_at / finalized_by が上書きされない。

  行が無い月はエラーにする（勝手に作らない）。
*/
create or replace function public.finalize_referral_month(
  p_target_month text
) returns table (
  target_month text,
  status text,
  finalized_at timestamptz,
  finalized_by uuid,
  already_finalized boolean
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_current public.referral_month_settlements%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  /*
    誰が確定したか分からないまま支払の前提条件を満たさせない。
    service role で直接呼ばれた場合はここで落ちる。
  */
  if v_actor is null then
    raise exception '確定者を特定できません。管理者としてログインした状態で実行してください'
      using errcode = '42501';
  end if;

  if p_target_month is null or p_target_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception '対象月の形式が不正です（YYYY-MM）: %',
      coalesce(p_target_month, '(null)') using errcode = '22023';
  end if;

  select * into v_current
    from public.referral_month_settlements
   where referral_month_settlements.target_month = p_target_month
     for update;

  if not found then
    raise exception '% の月次確定レコードがありません', p_target_month using errcode = '23503';
  end if;

  -- すでに確定済みなら監査情報を書き換えない
  if v_current.status = 'finalized' then
    return query
      select v_current.target_month, v_current.status,
             v_current.finalized_at, v_current.finalized_by, true;
    return;
  end if;

  return query
    update public.referral_month_settlements s
       set status = 'finalized',
           finalized_at = now(),
           finalized_by = v_actor,
           updated_at = now()
     where s.target_month = p_target_month
    returning s.target_month, s.status, s.finalized_at, s.finalized_by, false;
end;
$fn$;

revoke all on function public.finalize_referral_month(text) from public, anon;
grant execute on function public.finalize_referral_month(text) to authenticated;

comment on function public.finalize_referral_month(text) is
  '紹介者報酬の対象月を確定する。確定済みの月は監査情報を書き換えず already_finalized で返す。親管理者のみ。';

-- -----------------------------------------------------------------------------
-- 確定解除
-- -----------------------------------------------------------------------------
/*
  支払処理へ進んだ月は戻せない。

  確定を前提に支払明細を作った後で未確定へ戻せると、
  「支払対象にできない月の明細が支払明細に入っている」状態が生まれる。
  claim 済み・payout 紐付き・支払済みが1件でもあれば中止する。

  reward_amount / 紹介関係 / 支払明細には一切触れない。
  戻すのは settlement の3列だけ。
*/
create or replace function public.unfinalize_referral_month(
  p_target_month text
) returns table (
  target_month text,
  status text,
  released boolean
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_current public.referral_month_settlements%rowtype;
  v_claimed integer;
  v_paid integer;
  v_batches integer;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception '操作者を特定できません。管理者としてログインした状態で実行してください'
      using errcode = '42501';
  end if;

  if p_target_month is null or p_target_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception '対象月の形式が不正です（YYYY-MM）: %',
      coalesce(p_target_month, '(null)') using errcode = '22023';
  end if;

  select * into v_current
    from public.referral_month_settlements
   where referral_month_settlements.target_month = p_target_month
     for update;

  if not found then
    raise exception '% の月次確定レコードがありません', p_target_month using errcode = '23503';
  end if;

  if v_current.status <> 'finalized' then
    return query select v_current.target_month, v_current.status, false;
    return;
  end if;

  -- 支払処理へ進んだ明細があれば戻さない
  select
    count(*) filter (where i.payment_batch_id is not null or i.payout_id is not null),
    count(*) filter (where i.is_paid)
    into v_claimed, v_paid
    from public.referral_reward_items i
   where i.target_month = p_target_month;

  if v_paid > 0 then
    raise exception '% には支払済みの明細が % 件あるため確定を解除できません',
      p_target_month, v_paid using errcode = '22023';
  end if;

  if v_claimed > 0 then
    raise exception '% には支払明細に組み入れ済みの明細が % 件あるため確定を解除できません',
      p_target_month, v_claimed using errcode = '22023';
  end if;

  /*
    明細側だけでなく支払明細側からも確かめる。
    占有が外れた直後など、片側だけ見ると取りこぼす余地を残さない。
  */
  select count(*) into v_batches
    from public.payment_batches b
   where b.payee_kind = 'referrer'
     and b.status in ('draft', 'approved', 'processing', 'paid')
     and p_target_month between b.period_start_month and b.period_end_month;

  if v_batches > 0 then
    raise exception '% を含む紹介者の支払明細が % 件あるため確定を解除できません',
      p_target_month, v_batches using errcode = '22023';
  end if;

  return query
    update public.referral_month_settlements s
       set status = 'unfinalized',
           finalized_at = null,
           finalized_by = null,
           updated_at = now()
     where s.target_month = p_target_month
    returning s.target_month, s.status, true;
end;
$fn$;

revoke all on function public.unfinalize_referral_month(text) from public, anon;
grant execute on function public.unfinalize_referral_month(text) to authenticated;

comment on function public.unfinalize_referral_month(text) is
  '紹介者報酬の対象月の確定を解除する。支払処理へ進んだ明細が1件でもあれば中止する。親管理者のみ。';
