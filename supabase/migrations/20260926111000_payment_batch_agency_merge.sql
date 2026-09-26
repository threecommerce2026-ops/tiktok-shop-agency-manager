/*
  支払明細を代理店単位へ統合する。

  ■ 何を変えるか
  代理店の支払明細に、その代理店へ帰属する紹介者（referrers.agency_id）の
  紹介報酬も同じ明細へ組み入れる。支払は代理店へ1回だけ。

  ■ 何を変えないか
  ・報酬の計算式（agency_revenue / commission_base × 5% / 生涯上限）
  ・報酬明細そのもの。referral_reward_items を agency_reward_items へ
    変換したりはしない。会計・監査上の報酬種別はテーブル分離のまま保持する。
  ・二重支払い防止の4条件
      is_reward_target = true / is_paid = false
      payout_id is null / payment_batch_id is null
    これは緩めない。紹介報酬側にも同じ4条件を適用する。
  ・approve / processing / fail / cancel / 監査ログ

  ■ 最低支払額
  代理店の支払明細は合算額に対して基準額 0 円で判定する（claim の
  p_min_amount は呼び出し側が渡す）。紹介者単体の 1,000 円基準は、
  代理店へ正常に帰属している紹介者については支払判定に使わない。

  ■ 代理店へ帰属済みの紹介者は単独明細を作れない
  agency_id が入っている紹介者を payee_kind='referrer' で作ろうとすると
  拒否する。支払先が二重化して振込先の管理が破綻するため。
  agency_id が NULL の紹介者は従来経路を temporarily 維持する。
*/

-- ---------------------------------------------------------------------------
-- 1. 支払明細の作成と明細の占有
-- ---------------------------------------------------------------------------
create or replace function public.claim_payment_batch_items(
  p_payee_kind text,
  p_payee_id uuid,
  p_period_start_month text,
  p_period_end_month text,
  p_min_amount numeric default 0,
  p_memo text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_batch_id uuid;
  v_count integer := 0;
  v_amount numeric := 0;
  v_ref_count integer := 0;
  v_ref_amount numeric := 0;
  v_is_in_house boolean := false;
  v_payee_name text;
  v_referrer_agency_id uuid;
  v_bank_name text;
  v_bank_code text;
  v_branch_name text;
  v_branch_code text;
  v_account_type text;
  v_account_number text;
  v_account_holder text;
begin
  if not public.is_app_admin() then
    raise exception '支払明細の作成は親管理者のみ実行できます' using errcode = '42501';
  end if;

  -- ---- 入力検証 ----
  if p_payee_kind is null or p_payee_kind not in ('agency', 'referrer') then
    raise exception '支払先区分が不正です: %', p_payee_kind using errcode = '22023';
  end if;

  if p_payee_id is null then
    raise exception '支払先を指定してください' using errcode = '22023';
  end if;

  if p_period_start_month is null or p_period_end_month is null
     or p_period_start_month !~ '^\d{4}-\d{2}$'
     or p_period_end_month !~ '^\d{4}-\d{2}$' then
    raise exception '対象期間の形式が不正です（YYYY-MM）' using errcode = '22023';
  end if;

  if p_period_end_month < p_period_start_month then
    raise exception '対象期間の開始月が終了月より後になっています' using errcode = '22023';
  end if;

  if p_min_amount is null or p_min_amount < 0 then
    raise exception '支払基準額が不正です' using errcode = '22023';
  end if;

  -- ---- 支払先の存在・自社判定・振込先の充足 ----
  if p_payee_kind = 'agency' then
    select a.name, coalesce(a.is_in_house, false),
           a.bank_name, a.bank_code, a.bank_branch_name, a.bank_branch_code,
           a.bank_account_type, a.bank_account_number, a.bank_account_holder
      into v_payee_name, v_is_in_house,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder
      from public.agencies a
     where a.id = p_payee_id;
  else
    select coalesce(r.referrer_name, r.name), coalesce(r.is_in_house, false),
           r.bank_name, r.bank_code, r.bank_branch_name, r.bank_branch_code,
           r.bank_account_type, r.bank_account_number, r.bank_account_holder,
           r.agency_id
      into v_payee_name, v_is_in_house,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder,
           v_referrer_agency_id
      from public.referrers r
     where r.id = p_payee_id;
  end if;

  if v_payee_name is null then
    raise exception '支払先が見つかりません' using errcode = '23503';
  end if;

  if v_is_in_house then
    raise exception '「%」は自社です。外部への支払対象ではありません', v_payee_name
      using errcode = '22023';
  end if;

  /*
    代理店へ帰属している紹介者は、代理店の支払明細に合算される。
    紹介者単独の明細を作らせると支払先が二重になる。
  */
  if p_payee_kind = 'referrer' and v_referrer_agency_id is not null then
    raise exception '「%」は代理店に帰属しています。代理店単位で支払明細を作成してください', v_payee_name
      using errcode = '22023';
  end if;

  if coalesce(btrim(v_bank_name), '') = ''
     or coalesce(btrim(v_branch_name), '') = ''
     or coalesce(btrim(v_account_type), '') = ''
     or coalesce(btrim(v_account_number), '') = ''
     or coalesce(btrim(v_account_holder), '') = '' then
    raise exception '「%」の振込先が未登録です', v_payee_name using errcode = '22023';
  end if;

  if coalesce(btrim(v_bank_code), '') = ''
     or coalesce(btrim(v_branch_code), '') = '' then
    raise exception '「%」の金融機関コード / 支店コードが未登録です', v_payee_name
      using errcode = '22023';
  end if;

  -- ---- 支払明細を先に作る（占有の紐付け先が必要なため）----
  insert into public.payment_batches (
    payee_kind, agency_id, referrer_id,
    period_start_month, period_end_month,
    status, memo, created_by
  )
  values (
    p_payee_kind,
    case when p_payee_kind = 'agency' then p_payee_id else null end,
    case when p_payee_kind = 'referrer' then p_payee_id else null end,
    p_period_start_month,
    p_period_end_month,
    'draft',
    p_memo,
    auth.uid()
  )
  returning id into v_batch_id;

  -- ---- 対象明細を占有する ----
  -- WHERE の4条件が二重支払い防止そのもの。緩めてはいけない。
  if p_payee_kind = 'agency' then
    with claimed as (
      update public.agency_reward_items
         set payment_batch_id = v_batch_id,
             updated_at = now()
       where agency_id = p_payee_id
         and target_month >= p_period_start_month
         and target_month <= p_period_end_month
         and is_reward_target = true
         and is_paid = false
         and payout_id is null
         and payment_batch_id is null
      returning reward_amount as amount
    )
    select count(*), coalesce(sum(amount), 0) into v_count, v_amount from claimed;

    /*
      この代理店へ帰属する紹介者の紹介報酬も同じ明細へ組み入れる。
      判定は referrers.agency_id のみ。名前では寄せない。
    */
    with claimed as (
      update public.referral_reward_items ri
         set payment_batch_id = v_batch_id,
             updated_at = now()
       where ri.referrer_id in (
               select r.id from public.referrers r where r.agency_id = p_payee_id
             )
         and ri.target_month >= p_period_start_month
         and ri.target_month <= p_period_end_month
         and ri.is_reward_target = true
         and ri.is_paid = false
         and ri.payout_id is null
         and ri.payment_batch_id is null
      returning coalesce(ri.adjusted_reward_amount, ri.reward_amount, 0) as amount
    )
    select count(*), coalesce(sum(amount), 0) into v_ref_count, v_ref_amount from claimed;

    v_count := v_count + v_ref_count;
    v_amount := v_amount + v_ref_amount;
  else
    with claimed as (
      update public.referral_reward_items
         set payment_batch_id = v_batch_id,
             updated_at = now()
       where referrer_id = p_payee_id
         and target_month >= p_period_start_month
         and target_month <= p_period_end_month
         and is_reward_target = true
         and is_paid = false
         and payout_id is null
         and payment_batch_id is null
      returning coalesce(adjusted_reward_amount, reward_amount, 0) as amount
    )
    select count(*), coalesce(sum(amount), 0) into v_count, v_amount from claimed;
  end if;

  if v_count = 0 then
    raise exception '「%」に支払対象の未払い明細がありません（% 〜 %）',
      v_payee_name, p_period_start_month, p_period_end_month using errcode = '22023';
  end if;

  if v_amount <= 0 then
    raise exception '「%」の支払対象額が0円です', v_payee_name using errcode = '22023';
  end if;

  if v_amount < p_min_amount then
    raise exception '「%」の未払い累積が支払基準額に達していません（現在 % 円 / 基準 % 円）',
      v_payee_name, v_amount, p_min_amount using errcode = '22023';
  end if;

  update public.payment_batches
     set item_count = v_count,
         gross_amount = v_amount,
         payment_amount = v_amount,
         updated_at = now()
   where id = v_batch_id;

  perform public.log_payment_batch_action(
    v_batch_id, 'created', null, 'draft', v_count, v_amount, p_memo
  );

  return v_batch_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. 明細の解放
-- ---------------------------------------------------------------------------
create or replace function public.release_payment_batch_items(
  p_batch_id uuid,
  p_payee_kind text
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_paid_items integer := 0;
  v_released integer := 0;
begin
  /*
    代理店の明細は両テーブルに跨る。支払済みが1件でもあれば解放しない。
  */
  if p_payee_kind = 'agency' then
    select (select count(*) from public.agency_reward_items
             where payment_batch_id = p_batch_id and is_paid = true)
         + (select count(*) from public.referral_reward_items
             where payment_batch_id = p_batch_id and is_paid = true)
      into v_paid_items;
  else
    select count(*) into v_paid_items
      from public.referral_reward_items
     where payment_batch_id = p_batch_id and is_paid = true;
  end if;

  if v_paid_items > 0 then
    raise exception '支払済みの明細が % 件含まれているため解放できません', v_paid_items
      using errcode = '22023';
  end if;

  -- 解放するのはこの支払明細が占有している行だけ
  if p_payee_kind = 'agency' then
    with a as (
      update public.agency_reward_items
         set payment_batch_id = null, updated_at = now()
       where payment_batch_id = p_batch_id
         and is_paid = false
      returning 1
    ),
    r as (
      update public.referral_reward_items
         set payment_batch_id = null, updated_at = now()
       where payment_batch_id = p_batch_id
         and is_paid = false
      returning 1
    )
    select (select count(*) from a) + (select count(*) from r) into v_released;
  else
    with r as (
      update public.referral_reward_items
         set payment_batch_id = null, updated_at = now()
       where payment_batch_id = p_batch_id
         and is_paid = false
      returning 1
    )
    select count(*) into v_released from r;
  end if;

  return v_released;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. 振込完了の登録（is_paid を立てる唯一の場所）
-- ---------------------------------------------------------------------------
create or replace function public.complete_payment_batch(
  p_batch_id uuid,
  p_paid_on date default null,
  p_memo text default null
) returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_batch public.payment_batches%rowtype;
  v_paid_at timestamptz := now();
  v_today date;
  v_paid_on date;
  v_count integer := 0;
  v_ref_count integer := 0;
  v_amount numeric := 0;
  v_ref_amount numeric := 0;
  v_payout_id uuid;
  v_ref_payout_id uuid;
  v_ref record;
  v_pair record;
begin
  if not public.is_app_admin() then
    raise exception '振込完了の登録は親管理者のみ実行できます' using errcode = '42501';
  end if;

  select * into v_batch from public.payment_batches where id = p_batch_id for update;

  if not found then
    raise exception '支払明細が見つかりません' using errcode = '23503';
  end if;

  if v_batch.status = 'paid' then
    raise exception 'この支払明細は既に振込完了済みです' using errcode = '22023';
  end if;

  if v_batch.status not in ('approved', 'processing') then
    raise exception '振込完了を登録できるのは承認済み / 振込中の支払明細だけです（現在: %）',
      v_batch.status using errcode = '22023';
  end if;

  v_today := (v_paid_at at time zone 'Asia/Tokyo')::date;
  v_paid_on := coalesce(p_paid_on, v_today);

  if v_paid_on > v_today then
    raise exception '振込日に未来日は指定できません' using errcode = '22023';
  end if;

  if v_batch.payee_kind = 'agency' then
    -- 既存の支払履歴テーブルにも紐付ける（既存画面が参照するため）。
    -- 対象月は支払明細の終了月。同月の行が既にあれば再利用する。
    select id into v_payout_id
      from public.agency_payouts
     where target_month = v_batch.period_end_month
       and agency_id = v_batch.agency_id
     for update;

    if v_payout_id is null then
      insert into public.agency_payouts (
        target_month, agency_id, threshold_amount, is_payable, status
      )
      values (v_batch.period_end_month, v_batch.agency_id, 0, true, 'unpaid')
      returning id into v_payout_id;
    end if;

    with updated as (
      update public.agency_reward_items
         set is_paid = true,
             paid_at = v_paid_at,
             payout_id = v_payout_id,
             updated_at = v_paid_at
       where payment_batch_id = p_batch_id
         and is_paid = false
      returning 1
    )
    select count(*) into v_count from updated;

    select coalesce(sum(reward_amount), 0) into v_amount
      from public.agency_reward_items
     where payment_batch_id = p_batch_id;

    /*
      同じ支払明細に組み入れた紹介報酬も支払済みにする。
      対象はこの支払明細が占有している行だけ。他の明細は巻き込まない。
      紹介者ごとに referral_payouts を1行持たせ、既存の紹介者画面の
      整合性を保つ。
    */
    for v_ref in
      select distinct referrer_id
        from public.referral_reward_items
       where payment_batch_id = p_batch_id
    loop
      select id into v_ref_payout_id
        from public.referral_payouts
       where target_month = v_batch.period_end_month
         and referrer_id = v_ref.referrer_id
       for update;

      if v_ref_payout_id is null then
        insert into public.referral_payouts (
          target_month, referrer_id, is_payable, status
        )
        values (v_batch.period_end_month, v_ref.referrer_id, true, 'unpaid')
        returning id into v_ref_payout_id;
      end if;

      with updated as (
        update public.referral_reward_items
           set is_paid = true,
               paid_at = v_paid_at,
               payout_id = v_ref_payout_id,
               updated_at = v_paid_at
         where payment_batch_id = p_batch_id
           and referrer_id = v_ref.referrer_id
           and is_paid = false
        returning 1
      )
      select count(*) into v_ref_count from updated;

      v_count := v_count + v_ref_count;

      -- 支払履歴の金額は「その payout に紐付いた明細の実額」で置き直す
      update public.referral_payouts
         set total_reward_amount = (
               select coalesce(sum(coalesce(adjusted_reward_amount, reward_amount, 0)), 0)
                 from public.referral_reward_items
                where payout_id = v_ref_payout_id
             ),
             status = 'paid',
             is_payable = true,
             paid_at = v_paid_at,
             updated_at = v_paid_at
       where id = v_ref_payout_id;
    end loop;

    select coalesce(sum(coalesce(adjusted_reward_amount, reward_amount, 0)), 0)
      into v_ref_amount
      from public.referral_reward_items
     where payment_batch_id = p_batch_id;

    v_amount := v_amount + v_ref_amount;
  else
    select id into v_payout_id
      from public.referral_payouts
     where target_month = v_batch.period_end_month
       and referrer_id = v_batch.referrer_id
     for update;

    if v_payout_id is null then
      insert into public.referral_payouts (
        target_month, referrer_id, is_payable, status
      )
      values (v_batch.period_end_month, v_batch.referrer_id, true, 'unpaid')
      returning id into v_payout_id;
    end if;

    with updated as (
      update public.referral_reward_items
         set is_paid = true,
             paid_at = v_paid_at,
             payout_id = v_payout_id,
             updated_at = v_paid_at
       where payment_batch_id = p_batch_id
         and is_paid = false
      returning 1
    )
    select count(*) into v_count from updated;

    select coalesce(sum(coalesce(adjusted_reward_amount, reward_amount, 0)), 0)
      into v_amount
      from public.referral_reward_items
     where payment_batch_id = p_batch_id;
  end if;

  -- スナップショットと一致しなければトランザクション全体を巻き戻す
  if v_count <> v_batch.item_count then
    raise exception '明細件数が支払明細と一致しません（支払明細 % 件 / 更新 % 件）',
      v_batch.item_count, v_count using errcode = '23514';
  end if;

  if abs(v_amount - v_batch.payment_amount) > 0.005 then
    raise exception '金額が支払明細と一致しません（支払明細 % 円 / 実際 % 円）',
      v_batch.payment_amount, v_amount using errcode = '23514';
  end if;

  /*
    紹介報酬を支払ったら生涯上限の判定元（累計支払額）も進める。
    代理店の支払明細に合算した紹介報酬も対象。支払種別に依らず
    「この支払明細に含まれる紹介報酬」で判定する。
  */
  for v_pair in
    select creator_id,
           referrer_id,
           sum(coalesce(adjusted_reward_amount, reward_amount, 0)) as amount
      from public.referral_reward_items
     where payment_batch_id = p_batch_id
       and is_paid = true
     group by creator_id, referrer_id
  loop
    update public.creator_referrals
       set lifetime_paid_amount = coalesce(lifetime_paid_amount, 0) + v_pair.amount,
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

  -- 支払履歴テーブルの金額は「その payout に紐付いた明細の実額」で置き直す。
  -- 年初来累積スナップショットにはしない（二重計上の原因になるため）。
  if v_batch.payee_kind = 'agency' then
    update public.agency_payouts
       set total_reward_amount = (
             select coalesce(sum(reward_amount), 0)
               from public.agency_reward_items
              where payout_id = v_payout_id
           ),
           status = 'paid',
           is_payable = true,
           paid_at = v_paid_at,
           updated_at = v_paid_at
     where id = v_payout_id;
  else
    update public.referral_payouts
       set total_reward_amount = (
             select coalesce(sum(coalesce(adjusted_reward_amount, reward_amount, 0)), 0)
               from public.referral_reward_items
              where payout_id = v_payout_id
           ),
           status = 'paid',
           is_payable = true,
           paid_at = v_paid_at,
           updated_at = v_paid_at
     where id = v_payout_id;
  end if;

  update public.payment_batches
     set status = 'paid',
         paid_by = auth.uid(),
         paid_at = v_paid_at,
         paid_on = v_paid_on,
         memo = coalesce(p_memo, memo),
         updated_at = v_paid_at
   where id = p_batch_id;

  perform public.log_payment_batch_action(
    p_batch_id, 'paid', v_batch.status, 'paid', v_count, v_amount, p_memo
  );
end;
$fn$;
