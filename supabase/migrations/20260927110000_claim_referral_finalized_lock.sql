/*
  紹介者の支払明細（claim）へ、月次確定ロックを接続する。

  ■ なぜ必要か
  前フェーズで assert_referral_months_finalized を作ったが、
  claim_payment_batch_items から呼んでいなかった。
  現在 referrer の claim が通らないのは、代理店帰属の旧ガードに
  引っかかっているからで、偶然そうなっているだけだった。
  旧ガードを外す前に、意図したロックを先に繋いでおく。

  ■ 旧ガード（代理店帰属チェック）はこのマイグレーションでは外さない
  ロックが Production で効くことを確かめる前に外すと、
  どちらの保護も無い瞬間ができる。外すのは次フェーズ。

  ■ 見る範囲
  claim が実際に占有する範囲と同じ v_start_month 〜 p_cutoff_month。
  claim は target_month between v_start_month and p_cutoff_month を
  占有するので、その範囲の月がすべて確定していればよい。
  範囲を独自に決めない。

  ■ 代理店には掛けない
  代理店報酬は affiliate_order_lines が正で、TAP の取込状況と関係ない。
  既存の代理店支払の動きを変えない。
*/

-- -----------------------------------------------------------------------------
-- 1) ロック関数を強くする
-- -----------------------------------------------------------------------------
/*
  前版は「referral_reward_items がある月」だけを見ていた。
  それだと TAP 未取込で明細が1件も無い月を「問題なし」と誤って通してしまう。
  紹介者報酬は TAP 全量が揃うまで払わない方針なので、
  範囲内の月は、明細の有無にかかわらず finalized を要求する。

  referral_month_settlements に行が無い月も未確定として扱う。
  書き忘れで支払が通ってしまうのを避ける。
*/
create or replace function public.assert_referral_months_finalized(
  p_start_month text,
  p_cutoff_month text
) returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_pending text[];
begin
  select array_agg(m order by m) into v_pending
    from (
      select to_char(d, 'YYYY-MM') as m
        from generate_series(
               to_date(p_start_month || '-01', 'YYYY-MM-DD'),
               to_date(p_cutoff_month || '-01', 'YYYY-MM-DD'),
               interval '1 month'
             ) as d
    ) months
   where coalesce(
           (select s.status from public.referral_month_settlements s
             where s.target_month = months.m),
           'unfinalized'
         ) <> 'finalized';

  if v_pending is not null and array_length(v_pending, 1) > 0 then
    raise exception
      '紹介者報酬が未確定の月があります（%）。TAPの全量取込と確定を先に行ってください',
      array_to_string(v_pending, ', ')
      using errcode = '22023';
  end if;
end;
$fn$;

revoke all on function public.assert_referral_months_finalized(text, text) from public, anon;
grant execute on function public.assert_referral_months_finalized(text, text) to authenticated;

comment on function public.assert_referral_months_finalized(text, text) is
  '開始月から締め月までのすべての月が finalized か検査する。行が無い月も未確定として扱う。';

-- -----------------------------------------------------------------------------
-- 2) claim へ接続する（他の部分は現行のまま）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_payment_batch_items(p_payee_kind text, p_payee_id uuid, p_cutoff_month text, p_period_start_month text DEFAULT '2026-01'::text, p_min_amount numeric DEFAULT 0, p_memo text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch_id uuid;
  v_count integer := 0;
  v_amount numeric := 0;
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

  /*
    紹介者報酬は TAP を正データにする。全量が入って確定するまで支払わせない。

    見る範囲は、この claim が実際に占有する範囲と同じ
    （v_start_month 〜 p_cutoff_month）。占有する月だけを確かめるので、
    範囲外の月の未確定は邪魔にならない。

    代理店側には掛けない。代理店報酬は affiliate_order_lines が正で、
    TAP の取込状況とは無関係。
  */
  if p_payee_kind = 'referrer' then
    perform public.assert_referral_months_finalized(v_start_month, p_cutoff_month);
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
      紹介制度報酬は代理店へ支払わない。

      紹介者が代理店に所属していること（referrers.agency_id）と、
      その紹介制度報酬を代理店へ支払うことは別の話。
      代理店への支払は代理店分配報酬（agency_reward_items）だけで構成する。

      referral_reward_items はここでは一切 claim しない。会計・計算履歴として
      そのまま保持し、is_reward_target / reward_amount / is_paid / payout_id は
      触らない。「支払先が未定」であることは支払側が claim しないことで表す。
    */
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
$function$
;

revoke all on function public.claim_payment_batch_items(text, uuid, text, text, numeric, text) from public, anon;
grant execute on function public.claim_payment_batch_items(text, uuid, text, text, numeric, text) to authenticated;
