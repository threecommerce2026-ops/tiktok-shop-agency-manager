/*
  支払明細の作成を「締め対象月」ベースへ変える。

  ■ 何が変わるか
  これまでは呼び出し側が渡した期間の終端（p_period_end_month）が claim の
  上限だった。画面はその値を未払い明細の実データから導出していたため、
  締めていない月まで claim される状態だった。

  これからは p_cutoff_month を明示的に受け取り、claim の上限を
    target_month <= p_cutoff_month
  に固定する。期間の終端という曖昧な概念は引数から消す。
  古い画面が end_month を送っても、その引数自体が存在しないため
  締め月より後を claim する経路が構造的に無くなる。

  ■ 何を変えないか
  二重支払い防止の4条件
    is_reward_target = true / is_paid = false
    payout_id is null / payment_batch_id is null
  は1つも緩めない。代理店報酬と、その代理店へ帰属する紹介者報酬の
  両方に同じ cutoff と同じ4条件を適用する。

  ■ 入力検証はサーバー側で必ず行う
  フロントの検証だけに依存しない。形式・未来月・開始月との前後関係を
  この関数の中で弾く。判定は Asia/Tokyo。
*/

/*
  旧シグネチャ（p_period_end_month を取るもの）は残さない。
  残すと締め月を迂回する経路が生き続けるため、明示的に削除する。
*/
drop function if exists public.claim_payment_batch_items(
  text, uuid, text, text, numeric, text
);

create or replace function public.claim_payment_batch_items(
  p_payee_kind text,
  p_payee_id uuid,
  p_cutoff_month text,
  p_period_start_month text default '2026-01',
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
  v_current_month text;
  v_start_month text;
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

  /*
    締め対象月。YYYY-MM 以外は受け付けない。
    '2026-7' / '2026/07' / 空文字 / null はすべてここで落ちる。
  */
  if p_cutoff_month is null or p_cutoff_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception '締め対象月の形式が不正です（YYYY-MM）: %',
      coalesce(p_cutoff_month, '(null)') using errcode = '22023';
  end if;

  -- 締めていない当月より先は支払えない
  v_current_month := to_char((now() at time zone 'Asia/Tokyo')::date, 'YYYY-MM');
  if p_cutoff_month > v_current_month then
    raise exception '締め対象月に未来月は指定できません（指定 % / 当月 %）',
      p_cutoff_month, v_current_month using errcode = '22023';
  end if;

  v_start_month := coalesce(p_period_start_month, '2026-01');
  if v_start_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception '開始月の形式が不正です（YYYY-MM）: %', v_start_month using errcode = '22023';
  end if;
  if v_start_month > p_cutoff_month then
    raise exception '開始月が締め対象月より後になっています（開始 % / 締め %）',
      v_start_month, p_cutoff_month using errcode = '22023';
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

  /*
    支払明細を先に作る（占有の紐付け先が必要なため）。
    period_end_month は締め対象月そのものにする。これにより
    「この支払明細は何月末締めだったか」が後から必ず判定できる。
  */
  insert into public.payment_batches (
    payee_kind, agency_id, referrer_id,
    cutoff_month, period_start_month, period_end_month,
    status, memo, created_by
  )
  values (
    p_payee_kind,
    case when p_payee_kind = 'agency' then p_payee_id else null end,
    case when p_payee_kind = 'referrer' then p_payee_id else null end,
    p_cutoff_month,
    v_start_month,
    p_cutoff_month,
    'draft',
    p_memo,
    auth.uid()
  )
  returning id into v_batch_id;

  -- ---- 対象明細を占有する ----
  -- 上限は cutoff。WHERE の4条件が二重支払い防止そのもので、緩めてはいけない。
  if p_payee_kind = 'agency' then
    with claimed as (
      update public.agency_reward_items
         set payment_batch_id = v_batch_id,
             updated_at = now()
       where agency_id = p_payee_id
         and target_month >= v_start_month
         and target_month <= p_cutoff_month
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
      cutoff も4条件も代理店報酬と完全に同じものを使う。
    */
    with claimed as (
      update public.referral_reward_items ri
         set payment_batch_id = v_batch_id,
             updated_at = now()
       where ri.referrer_id in (
               select r.id from public.referrers r where r.agency_id = p_payee_id
             )
         and ri.target_month >= v_start_month
         and ri.target_month <= p_cutoff_month
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
         and target_month >= v_start_month
         and target_month <= p_cutoff_month
         and is_reward_target = true
         and is_paid = false
         and payout_id is null
         and payment_batch_id is null
      returning coalesce(adjusted_reward_amount, reward_amount, 0) as amount
    )
    select count(*), coalesce(sum(amount), 0) into v_count, v_amount from claimed;
  end if;

  if v_count = 0 then
    raise exception '「%」に支払対象の未払い明細がありません（% 末締め）',
      v_payee_name, p_cutoff_month using errcode = '22023';
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
    v_batch_id, 'created', null, 'draft', v_count, v_amount,
    coalesce(p_memo, '') || case when coalesce(p_memo,'') = '' then '' else ' / ' end
      || p_cutoff_month || ' 末締め'
  );

  return v_batch_id;
end;
$fn$;
