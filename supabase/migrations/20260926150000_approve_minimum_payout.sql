/*
  承認時にも最低支払額を確認する。

  ■ なぜ承認側でも見るか
  支払明細の作成時（claim）にも p_min_amount で判定しているが、作成後に
  報酬を再集計して金額が下がった下書きが残り得る。承認は振込先を固定する
  操作なので、その直前にもう一度確認する。

  ■ 単体承認・一括承認の両方に効く
  approve_payment_batch も approve_payment_batches_bulk も
  approve_one_payment_batch を呼ぶので、ここへ1度入れれば両方に効く。
  一括承認は1トランザクションなので、1件でも未満が混ざれば全件ロールバックする。

  ■ 判定額
  v_batch.payment_amount は claim 時に占有した明細の合計、つまり締め月までの
  未払い累積。単月ではない。代理店の場合その合計に紹介制度報酬は含まれない。

  ■ 値の二重管理
  RPC は SQL なので TypeScript の定数を共有できない。
  lib/payments/minimum-payout.ts の DEFAULT_MINIMUM_PAYOUT_YEN と同じ 1000 を置き、
  scripts/test-minimum-payout.mjs が両者の一致を検証する。

  テーブル変更・データ操作はしない。
*/

CREATE OR REPLACE FUNCTION public.approve_one_payment_batch(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch public.payment_batches%rowtype;
  v_payee_name text;
  v_bank_name text;
  v_bank_code text;
  v_branch_name text;
  v_branch_code text;
  v_account_type text;
  v_account_number text;
  v_account_holder text;
  v_agency_count integer := 0;
  v_agency_amount numeric := 0;
  v_referral_count integer := 0;
  -- 最低支払額。lib/payments/minimum-payout.ts の 1000 と同じ値
  v_minimum_payout constant numeric := 1000;
begin
  select * into v_batch from public.payment_batches where id = p_batch_id for update;

  if not found then
    raise exception '支払明細が見つかりません' using errcode = '23503';
  end if;

  if v_batch.status <> 'draft' then
    raise exception '承認できるのは下書きの支払明細だけです（現在: %）', v_batch.status
      using errcode = '22023';
  end if;

  if coalesce(v_batch.payment_amount, 0) <= 0 then
    raise exception '支払対象額が0円の支払明細は承認できません' using errcode = '22023';
  end if;

  /*
    承認時点の振込先を複写して固定する。
    以後マスタ側の口座が変わっても、この支払明細の振込先は変わらない。
  */
  if v_batch.payee_kind = 'agency' then
    if v_batch.agency_id is null then
      raise exception '代理店が特定できない支払明細は承認できません' using errcode = '22023';
    end if;

    select a.name,
           a.bank_name, a.bank_code, a.bank_branch_name, a.bank_branch_code,
           a.bank_account_type, a.bank_account_number, a.bank_account_holder
      into v_payee_name,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder
      from public.agencies a where a.id = v_batch.agency_id;
  else
    if v_batch.referrer_id is null then
      raise exception '紹介者が特定できない支払明細は承認できません' using errcode = '22023';
    end if;

    select coalesce(r.referrer_name, r.name),
           r.bank_name, r.bank_code, r.bank_branch_name, r.bank_branch_code,
           r.bank_account_type, r.bank_account_number, r.bank_account_holder
      into v_payee_name,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder
      from public.referrers r where r.id = v_batch.referrer_id;
  end if;

  if v_payee_name is null then
    raise exception '支払先が見つかりません' using errcode = '23503';
  end if;

  /*
    最低支払額。

    支払明細の作成時にも claim RPC の p_min_amount で判定しているが、
    作成後に報酬を再集計して金額が下がった下書きが残り得る。承認は振込先を
    固定する操作なので、その直前にもう一度確認する。
    未満なら支払わず、翌月以降へ繰り越す（明細は消さない）。
  */
  if v_batch.payment_amount < v_minimum_payout then
    raise exception
      '「%」の未払い累積が最低支払額に達していないため承認できません（現在 % 円 / 最低 % 円）。翌月以降へ繰り越してください',
      v_payee_name, v_batch.payment_amount, v_minimum_payout
      using errcode = '22023';
  end if;

  if coalesce(btrim(v_bank_name), '') = ''
     or coalesce(btrim(v_bank_code), '') = ''
     or coalesce(btrim(v_branch_name), '') = ''
     or coalesce(btrim(v_branch_code), '') = ''
     or coalesce(btrim(v_account_type), '') = ''
     or coalesce(btrim(v_account_number), '') = ''
     or coalesce(btrim(v_account_holder), '') = '' then
    raise exception '「%」の振込先が不足しているため承認できません', v_payee_name
      using errcode = '22023';
  end if;

  /*
    占有している明細と支払明細のスナップショットが合っているかを確認する。
    ずれているまま承認すると、振込完了の登録で必ず失敗する。
  */
  if v_batch.payee_kind = 'agency' then
    select count(*), coalesce(sum(reward_amount), 0)
      into v_agency_count, v_agency_amount
      from public.agency_reward_items where payment_batch_id = p_batch_id;

    select count(*) into v_referral_count
      from public.referral_reward_items where payment_batch_id = p_batch_id;

    if v_agency_count = 0 then
      raise exception '「%」の支払明細に対象明細がありません', v_payee_name using errcode = '22023';
    end if;

    -- 代理店へ紹介制度報酬は支払わない
    if v_referral_count > 0 then
      raise exception '「%」の支払明細に紹介制度報酬が % 件含まれています。代理店へ紹介制度報酬は支払いません',
        v_payee_name, v_referral_count using errcode = '22023';
    end if;

    if v_agency_count <> v_batch.item_count then
      raise exception '「%」の明細件数が支払明細と一致しません（支払明細 % 件 / 実際 % 件）',
        v_payee_name, v_batch.item_count, v_agency_count using errcode = '23514';
    end if;

    if abs(v_agency_amount - v_batch.payment_amount) > 0.005 then
      raise exception '「%」の金額が支払明細と一致しません（支払明細 % 円 / 実際 % 円）',
        v_payee_name, v_batch.payment_amount, v_agency_amount using errcode = '23514';
    end if;
  end if;

  update public.payment_batches
     set status = 'approved',
         bank_name = v_bank_name,
         bank_code = v_bank_code,
         bank_branch_name = v_branch_name,
         bank_branch_code = v_branch_code,
         bank_account_type = v_account_type,
         bank_account_number = v_account_number,
         bank_account_holder = v_account_holder,
         approved_by = auth.uid(),
         approved_at = now(),
         updated_at = now()
   where id = p_batch_id;

  perform public.log_payment_batch_action(
    p_batch_id, 'approved', 'draft', 'approved',
    v_batch.item_count, v_batch.payment_amount, null
  );
end;
$function$;
