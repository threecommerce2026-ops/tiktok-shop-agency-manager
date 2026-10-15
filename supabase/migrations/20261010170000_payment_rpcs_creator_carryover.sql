-- =============================================================================
-- 支払RPC に振込端数の繰越を組み込む／ creator 対応の確認関数
-- =============================================================================
/*
  ■ 変えること（M-4 / M-6 / 最低振込額 1,000円）
    claim_payment_batch_items   creator の最低振込額を「明細 + 繰越」で判定し、
                                振込額を1円単位へ切り捨て、端数を繰越残高へ回す
    approve_one_payment_batch   振込額 = 明細 + 取り込んだ繰越 − 次回繰越
                                を検証する
    complete_payment_batch      振込完了時も同じ式で検証する
                                （明細の合計と payment_amount は一致しない）
    release_payment_batch_items 取消・失敗で繰越を claim 前へ戻す
    payment_batch_supports_creator  creator 対応かを画面から確かめる（新規）

  ■ 代理店・紹介者の経路は変えない
  v_pay_amount は既定で明細の合計（従来と同じ）。
  creator の分岐に入ったときだけ切り捨てと繰越を行う。
  approve も creator 以外の検証条件は1文字も変えていない。

  ■ 二重支払い・消失を防ぐしくみ
  繰越の増減は creator_lending_carryover_logs に必ず記録する。
      unique (payment_batch_id, action)
  同じ支払明細に対する二重の取り込み（applied）・二重の復元（reverted）は
  DB が弾く。復元は「balance_before へ戻す」なので誤差が積まない。

  ■ 最低振込額 1,000円（2026-10-11 確定 / 2026-10-12 下限を保護）
  creator の claim は p_min_amount を greatest(p_min_amount, 1000) に丸める。
  呼び出し側が 0 や 500 を渡しても 1,000円未満では支払えない。
  「明細の合計 + 繰越残高」が 1,000円未満のときは claim が例外で止まる。
  トランザクション全体が巻き戻るので、支払明細は作られず、
  明細の占有も繰越残高の消費も起きない。
  未払明細はそのまま残り、次回の支払候補に合算される（失効させない）。
  承認（approve）でも同じ下限を確認する。

  ■ 1円未満しか無いとき
  claim が例外で止まる。明細の占有も繰越も巻き戻るので、
  端数は残高に残ったまま次回へ繰り越される。

  ■ 適用順序
  20261010130000（支払RPC）と 20261010160000（繰越テーブル）より後。
  この3本は同一トランザクションで適用してよい。
  何度流しても結果は同じ（create or replace のみ）。

  ■ 適用時の DML は 0 件（関数の作り直しだけ）
*/

-- ① claim: 振込額の切り捨てと繰越の取り込み ----------------------------------
CREATE OR REPLACE FUNCTION public.claim_payment_batch_items(p_payee_kind text, p_payee_id uuid, p_cutoff_month text, p_period_start_month text DEFAULT '2026-01'::text, p_min_amount numeric DEFAULT 0, p_memo text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch_id uuid;
  /* 端末貸し出しの振込端数と繰越。creator 以外では使わない */
  v_min_amount numeric := 0;
  v_carry_in numeric := 0;
  v_carry_out numeric := 0;
  v_carry_gross numeric := 0;
  v_pay_amount numeric := 0;
  v_count integer := 0;
  v_amount numeric := 0;
  v_is_in_house boolean := false;
  v_payee_name text;
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
  if p_payee_kind is null or p_payee_kind not in ('agency', 'referrer', 'creator') then
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
  elsif p_payee_kind = 'creator' then
    /*
      端末貸し出し報酬の受取人はクリエイター本人。
      口座は creator_bank_accounts（本人専用テーブル）から引く。
      is_in_house は本人には無い概念なので false 固定にする。
    */
    select coalesce(nullif(btrim(c.creator_name), ''), c.tiktok_id), false,
           b.bank_name, b.bank_code, b.bank_branch_name, b.bank_branch_code,
           b.bank_account_type, b.bank_account_number, b.bank_account_holder
      into v_payee_name, v_is_in_house,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder
      from public.creators c
      left join public.creator_bank_accounts b on b.creator_id = c.id
     where c.id = p_payee_id;
  else
    select coalesce(r.referrer_name, r.name), coalesce(r.is_in_house, false),
           r.bank_name, r.bank_code, r.bank_branch_name, r.bank_branch_code,
           r.bank_account_type, r.bank_account_number, r.bank_account_holder
      into v_payee_name, v_is_in_house,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder
      from public.referrers r
     where r.id = p_payee_id;
  end if;

  if v_payee_name is null then
    raise exception '支払先が見つかりません' using errcode = '23503';
  end if;

  /*
    自社の代理店は外部への支払対象ではない。

    紹介者側は下の is_referrer_payout_excluded() で判定する（2026-10-08 改定）。
    以前はここで紹介者を除外せず「支払うかどうかは EMI が判断する」運用に
    していたが、自社紹介者・「-」・個別除外は振込まないと確定したため、
    画面側だけでなく DB 側でも止める。報酬の実績データは残す。
  */
  if p_payee_kind = 'agency' and v_is_in_house then
    raise exception '「%」は自社です。外部への支払対象ではありません', v_payee_name
      using errcode = '22023';
  end if;

  /*
    支払対象外の紹介者は支払明細を作らせない（2026-10-08 確定）。

    紹介報酬の実績（referral_reward_items）はそのまま残す。ここで止めるのは
    「占有して振込に進める」操作だけ。判定は is_referrer_payout_excluded() に
    集約し、該当行が無い / NULL のときは除外側に倒れる。
  */
  if p_payee_kind = 'referrer' and public.is_referrer_payout_excluded(p_payee_id) then
    raise exception '「%」は支払対象外の紹介者です。紹介報酬の実績は残りますが振込は行いません',
      v_payee_name using errcode = '22023';
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
    /*
      2026-08 以降は紹介報酬の発生データが揃っていない。
        ・TAP 由来 0 件（2026-08 の TAP は未払い 871 行を含み全量未確定）
        ・旧 affiliate 由来 32 件 / 5,698.85 円 が残ったまま
      この状態で締めると根拠の無い額を支払うことになるため、
      紹介者の締め月に上限を置く。代理店側には掛けない。

      2026-08 の TAP を全量取り込んで置き換えたら、この上限を進める。
      lib/payments/cutoff-month.ts の MAX_REFERRAL_PAYMENT_CUTOFF_MONTH と
      同じ値にすること（scripts のテストが一致を検証する）。
    */
    if p_cutoff_month > '2026-07' then
      raise exception
        '紹介者報酬は 2026-07 末締めまでが対象です（指定 %）。それ以降は TAP の全量取込が済んでいません',
        p_cutoff_month using errcode = '22023';
    end if;

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
    payee_kind, agency_id, referrer_id, payee_creator_id,
    cutoff_month, period_start_month, period_end_month,
    status, memo, created_by
  )
  values (
    p_payee_kind,
    case when p_payee_kind = 'agency' then p_payee_id else null end,
    case when p_payee_kind = 'referrer' then p_payee_id else null end,
    case when p_payee_kind = 'creator' then p_payee_id else null end,
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
      触らない。
    */
  elsif p_payee_kind = 'creator' then
    /*
      端末貸し出し報酬の明細だけを占有する。
      WHERE の4条件（is_reward_target / is_paid / payout_id / payment_batch_id）は
      既存2種と同じ二重支払い防止そのもので、緩めてはいけない。
    */
    with claimed as (
      update public.creator_lending_reward_items
         set payment_batch_id = v_batch_id,
             updated_at = now()
       where creator_id = p_payee_id
         and target_month >= v_start_month
         and target_month <= p_cutoff_month
         and is_reward_target = true
         and is_paid = false
         and payout_id is null
         and payment_batch_id is null
      returning reward_amount as amount
    )
    select count(*), coalesce(sum(amount), 0) into v_count, v_amount from claimed;
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
         -- 「今回は支払わない」にした明細は占有しない
         and payment_hold_reason is null
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

  /*
    最低振込額の判定。

    代理店・紹介者は従来どおり「明細の合計」で判定する。

    クリエイター本人（端末貸し出し）は「明細の合計 + 繰越残高」で判定する。
    繰越残高は1円未満の端数なので、境界ではこれを含めないと
    判定を誤る（例: 明細 999.80 + 繰越 0.30 = 1,000.10 → 支払対象）。
    判定は下の creator の分岐で行う。
  */
  if p_payee_kind <> 'creator' and v_amount < p_min_amount then
    raise exception '「%」の未払い累積が支払基準額に達していません（現在 % 円 / 基準 % 円）',
      v_payee_name, v_amount, p_min_amount using errcode = '22023';
  end if;

  /*
    --- 振込額の確定 -----------------------------------------------------------

    代理店・紹介者は従来どおり明細の合計をそのまま振込額にする。

    クリエイター本人（端末貸し出し）は AP × 分配率で銭が出るため、
    繰越残高を足して1円単位へ切り捨て、残った端数を次回へ繰り越す。

        振込額   = floor(明細の合計 + 繰越残高)
        次回繰越 = 明細の合計 + 繰越残高 − 振込額      0 以上 1 未満

    アプリ側の単一ソースは lib/payments/creator-lending-rounding.ts。
    業務ルールとして確定済み（2026-10-11 / 2026-10-12 承認）。
  */
  v_pay_amount := v_amount;

  if p_payee_kind = 'creator' then
    /* 繰越残高の行を押さえる（同時実行で二重に取り込まないため） */
    insert into public.creator_lending_carryovers (creator_id, balance)
    values (p_payee_id, 0)
    on conflict (creator_id) do nothing;

    select balance into v_carry_in
      from public.creator_lending_carryovers
     where creator_id = p_payee_id
       for update;

    v_carry_in := coalesce(v_carry_in, 0);
    v_carry_gross := round(v_amount + v_carry_in, 2);
    v_pay_amount := floor(v_carry_gross);
    v_carry_out := round(v_carry_gross - v_pay_amount, 2);

    /*
      --- 最低振込額 1,000円（2026-10-11 確定 / 2026-10-12 下限を保護）--------

      「明細の合計 + 繰越残高」が最低振込額に達していなければ振り込まない。

      下限は 1,000円で、呼び出し側が p_min_amount にそれより小さい値
      （0 や null を含む）を渡しても 1,000円として扱う。
      アプリの定数を環境変数で下げられても、画面を迂回して RPC を直接
      呼ばれても、1,000円未満では支払えないようにするため。
      引き上げ（1,000円超）はそのまま尊重する。

      例外で抜けるとトランザクション全体が巻き戻るので、
        ・支払明細（payment_batches）は残らない
        ・明細の占有（payment_batch_id）も元に戻る
        ・繰越残高も消費されない
      未払明細はそのまま残り、次回の支払候補に合算される（失効させない）。
    */
    v_min_amount := greatest(coalesce(p_min_amount, 0), 1000);

    if v_carry_gross < v_min_amount then
      raise exception
        '「%」の支払可能額が最低振込額に達していません（明細 % 円 + 繰越 % 円 = % 円 / 最低 % 円）。未払いは翌月以降へ繰り越します',
        v_payee_name, v_amount, v_carry_in, v_carry_gross, v_min_amount
        using errcode = '22023';
    end if;

    /*
      1円未満しか無いときも支払明細を作らない（0円振込を作らない）。
      最低振込額 1,000円のもとでは通常起きないが、下限を下げた場合の保険。
    */
    if v_pay_amount < 1 then
      raise exception
        '「%」の振込額が1円未満です（明細 % 円 + 繰越 % 円）。端数は繰越残高に残ります',
        v_payee_name, v_amount, v_carry_in using errcode = '22023';
    end if;

    update public.creator_lending_carryovers
       set balance = v_carry_out,
           updated_at = now()
     where creator_id = p_payee_id;

    /*
      移動を履歴に残す。unique (payment_batch_id, action) があるので
      同じ支払明細に対する二重の取り込みは DB が弾く。
    */
    insert into public.creator_lending_carryover_logs (
      creator_id, payment_batch_id, action,
      carryover_in, carryover_out, items_amount, transfer_amount,
      balance_before, balance_after
    )
    values (
      p_payee_id, v_batch_id, 'applied',
      v_carry_in, v_carry_out, v_amount, v_pay_amount,
      v_carry_in, v_carry_out
    );
  end if;

  update public.payment_batches
     set item_count = v_count,
         /* 明細の実額（銭のまま）。振込額とは別に残す */
         gross_amount = v_amount,
         payment_amount = v_pay_amount,
         updated_at = now()
   where id = v_batch_id;

  perform public.log_payment_batch_action(
    v_batch_id, 'created', null, 'draft', v_count, v_pay_amount,
    coalesce(p_memo, '') || case when coalesce(p_memo,'') = '' then '' else ' / ' end
      || p_cutoff_month || ' 末締め'
  );

  return v_batch_id;
end;
$function$;

-- ② approve: 振込額 = 明細 + 繰越 − 端数 を検証 -------------------------------
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
  /* 端末貸し出しの繰越（applied の履歴から読む） */
  v_carry_in numeric := 0;
  v_carry_out numeric := 0;
  v_carry_found boolean := false;
  v_expected_amount numeric := 0;
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
    支払対象外の紹介者の支払明細は進めない（2026-10-08 確定）。
    判定は public.is_referrer_payout_excluded() に集約している。
  */
  if v_batch.payee_kind = 'referrer'
     and public.is_referrer_payout_excluded(v_batch.referrer_id) then
    raise exception '「%」は支払対象外の紹介者です。紹介報酬の実績は残りますが振込は行いません',
      coalesce((select coalesce(r.referrer_name, r.name) from public.referrers r
                 where r.id = v_batch.referrer_id), '(不明)')
      using errcode = '22023';
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
  elsif v_batch.payee_kind = 'creator' then
    if v_batch.payee_creator_id is null then
      raise exception 'クリエイターが特定できない支払明細は承認できません' using errcode = '22023';
    end if;

    /* 本人の口座は creator_bank_accounts（本人専用テーブル）から複写する */
    select coalesce(nullif(btrim(c.creator_name), ''), c.tiktok_id),
           b.bank_name, b.bank_code, b.bank_branch_name, b.bank_branch_code,
           b.bank_account_type, b.bank_account_number, b.bank_account_holder
      into v_payee_name,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder
      from public.creators c
      left join public.creator_bank_accounts b on b.creator_id = c.id
     where c.id = v_batch.payee_creator_id;
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
  /*
    端末貸し出し報酬（クリエイター本人）の最低振込額も 1,000円（2026-10-11 確定）。

    claim の時点で「明細 + 繰越」が 1,000円以上であることを確かめているが、
    下書きのまま報酬が再集計されて金額が下がることがあるため、
    振込先を固定する承認の直前にもう一度確認する。
    未満なら支払わず、未払いのまま翌月以降へ繰り越す。

    あわせて振込額が1円未満の支払明細も承認させない
    （下限を下げた場合の保険）。
  */
  if v_batch.payee_kind = 'creator' and v_batch.payment_amount < 1 then
    raise exception
      '「%」の振込額が1円未満です（% 円）。端数は繰越残高として次回へ回ります',
      v_payee_name, v_batch.payment_amount using errcode = '22023';
  end if;

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
  elsif v_batch.payee_kind = 'creator' then
    /*
      端末貸し出し報酬の明細だけが占有されていることを確かめる。
      代理店報酬・紹介報酬が混ざっていたら承認しない。
    */
    select count(*), coalesce(sum(reward_amount), 0)
      into v_agency_count, v_agency_amount
      from public.creator_lending_reward_items where payment_batch_id = p_batch_id;

    if v_agency_count = 0 then
      raise exception '「%」の支払明細に対象明細がありません', v_payee_name using errcode = '22023';
    end if;

    select (select count(*) from public.agency_reward_items where payment_batch_id = p_batch_id)
         + (select count(*) from public.referral_reward_items where payment_batch_id = p_batch_id)
      into v_referral_count;

    if v_referral_count > 0 then
      raise exception '「%」の支払明細に端末貸し出し以外の報酬が % 件含まれています',
        v_payee_name, v_referral_count using errcode = '22023';
    end if;

    if v_agency_count <> v_batch.item_count then
      raise exception '「%」の明細件数が支払明細と一致しません（支払明細 % 件 / 実際 % 件）',
        v_payee_name, v_batch.item_count, v_agency_count using errcode = '23514';
    end if;

    /*
      振込額の検証（端数繰越を考慮する）。

          振込額 = 明細の合計 + 取り込んだ繰越 − 次回へ繰り越す端数

      claim が残した applied の履歴から繰越を読む。履歴が無い支払明細
      （繰越の導入前に作ったもの）は、従来どおり明細の合計と一致すること
      を求める。
    */
    select cl.carryover_in, cl.carryover_out, true
      into v_carry_in, v_carry_out, v_carry_found
      from public.creator_lending_carryover_logs cl
     where cl.payment_batch_id = p_batch_id
       and cl.action = 'applied';

    if coalesce(v_carry_found, false) then
      if v_carry_out < 0 or v_carry_out >= 1 then
        raise exception '「%」の繰越残高が範囲外です（% 円）。0 以上 1 円未満でなければなりません',
          v_payee_name, v_carry_out using errcode = '23514';
      end if;

      v_expected_amount := round(v_agency_amount + v_carry_in - v_carry_out, 2);

      /* 振込額は1円単位でなければならない */
      if v_batch.payment_amount <> floor(v_batch.payment_amount) then
        raise exception '「%」の振込額が1円単位ではありません（% 円）',
          v_payee_name, v_batch.payment_amount using errcode = '23514';
      end if;
    else
      v_expected_amount := v_agency_amount;
    end if;

    if abs(v_expected_amount - v_batch.payment_amount) > 0.005 then
      raise exception
        '「%」の金額が支払明細と一致しません（支払明細 % 円 / 明細 % 円 + 繰越 % 円 − 端数 % 円 = % 円）',
        v_payee_name, v_batch.payment_amount, v_agency_amount,
        v_carry_in, v_carry_out, v_expected_amount using errcode = '23514';
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

-- ③ complete: 振込完了時も 明細 + 繰越 − 端数 で検証 -------------------------
CREATE OR REPLACE FUNCTION public.complete_payment_batch(p_batch_id uuid, p_paid_on date DEFAULT NULL::date, p_memo text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  /* 端末貸し出しの繰越（applied の履歴から読む。creator 以外では使わない） */
  v_carry_in numeric := 0;
  v_carry_out numeric := 0;
  v_carry_found boolean := false;
  v_expected_amount numeric := 0;
  /* 対象月ごとの支払予定を作り直すために使う（creator のみ） */
  v_month text;
  v_month_count integer := 0;
  v_month_paid_count integer := 0;
  v_month_reward numeric := 0;
  v_month_self numeric := 0;
  v_month_unpaid numeric := 0;
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

  /*
    支払対象外の紹介者の支払明細は進めない（2026-10-08 確定）。
    判定は public.is_referrer_payout_excluded() に集約している。
  */
  if v_batch.payee_kind = 'referrer'
     and public.is_referrer_payout_excluded(v_batch.referrer_id) then
    raise exception '「%」は支払対象外の紹介者です。紹介報酬の実績は残りますが振込は行いません',
      coalesce((select coalesce(r.referrer_name, r.name) from public.referrers r
                 where r.id = v_batch.referrer_id), '(不明)')
      using errcode = '22023';
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
  elsif v_batch.payee_kind = 'creator' then
    /*
      端末貸し出し報酬（本人受取）。

      ■ 支払予定は「対象月ごと」に作る
      1つの支払明細が複数月をまとめて含むことがある（締め月までの未払いを
      まとめて占有するため）。締め月の1行だけに全額を入れると、
      月別の支払予定額と実際に支払った月別の明細が合わなくなる。
      会計照合と CSV で月別に突き合わせられるよう、明細に含まれる
      すべての対象月について1行ずつ作る（M-3 の続き）。

      ■ 再集計を待たずに一致させる
      金額と状態は「その月の明細すべて」から数え直す。
      この支払分だけを足すのではないので、sync を回さなくても
      支払予定 = その月の明細の実態になる。

      ■ 既にある行は再利用する（二重に作らない）
      unique (target_month, creator_id) があるので行は増えない。
    */
    v_count := 0;
    v_amount := 0;

    for v_month in
      select distinct target_month
        from public.creator_lending_reward_items
       where payment_batch_id = p_batch_id
       order by 1
    loop
      select id into v_payout_id
        from public.creator_lending_payouts
       where target_month = v_month
         and creator_id = v_batch.payee_creator_id
       for update;

      if v_payout_id is null then
        insert into public.creator_lending_payouts (
          target_month, creator_id, threshold_amount, is_payable, status
        )
        values (v_month, v_batch.payee_creator_id, 0, true, 'unpaid')
        returning id into v_payout_id;
      end if;

      /* その月の明細を支払済みにし、その月の支払予定へ紐付ける */
      with updated as (
        update public.creator_lending_reward_items
           set is_paid = true,
               paid_at = v_paid_at,
               payout_id = v_payout_id,
               updated_at = v_paid_at
         where payment_batch_id = p_batch_id
           and target_month = v_month
           and is_paid = false
        returning reward_amount
      )
      select v_count + count(*), v_amount + coalesce(sum(reward_amount), 0)
        into v_count, v_amount
        from updated;

      /*
        その月の明細すべてから数え直す。
        一部だけ支払った月は unpaid のまま残し、全部払い終えたら paid。
      */
      select count(*), count(*) filter (where is_paid),
             coalesce(sum(reward_amount), 0), coalesce(sum(self_share_amount), 0),
             coalesce(sum(case when is_paid then 0 else reward_amount end), 0)
        into v_month_count, v_month_paid_count,
             v_month_reward, v_month_self, v_month_unpaid
        from public.creator_lending_reward_items
       where creator_id = v_batch.payee_creator_id
         and target_month = v_month
         and is_reward_target = true;

      update public.creator_lending_payouts
         set total_reward_amount = v_month_reward,
             total_self_share_amount = v_month_self,
             threshold_amount = 0,
             is_payable = v_month_unpaid > 0,
             status = case
               when v_month_count > 0 and v_month_paid_count = v_month_count then 'paid'
               else 'unpaid'
             end,
             paid_at = case
               when v_month_count > 0 and v_month_paid_count = v_month_count
                 then coalesce(paid_at, v_paid_at)
               else paid_at
             end,
             updated_at = v_paid_at
       where id = v_payout_id;
    end loop;
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

  /*
    --- 振込額の検証（端数繰越を考慮する）-------------------------------------

    クリエイター本人は振込額を1円単位へ切り捨てているため、
    明細の合計（銭）と payment_amount は一致しない。

        振込額 = 明細の合計 + 取り込んだ繰越 − 次回へ繰り越す端数

    claim が残した applied の履歴から繰越を読む。履歴が無い支払明細
    （繰越の導入前に作ったもの）と 代理店・紹介者は従来どおり
    明細の合計と一致することを求める。
  */
  v_expected_amount := v_amount;

  if v_batch.payee_kind = 'creator' then
    select cl.carryover_in, cl.carryover_out, true
      into v_carry_in, v_carry_out, v_carry_found
      from public.creator_lending_carryover_logs cl
     where cl.payment_batch_id = p_batch_id
       and cl.action = 'applied';

    if coalesce(v_carry_found, false) then
      if v_carry_out < 0 or v_carry_out >= 1 then
        raise exception '繰越残高が範囲外です（% 円）。0 以上 1 円未満でなければなりません',
          v_carry_out using errcode = '23514';
      end if;

      v_expected_amount := round(v_amount + v_carry_in - v_carry_out, 2);
    end if;
  end if;

  if abs(v_expected_amount - v_batch.payment_amount) > 0.005 then
    raise exception
      '金額が支払明細と一致しません（支払明細 % 円 / 明細 % 円 + 繰越 % 円 − 端数 % 円 = % 円）',
      v_batch.payment_amount, v_amount, v_carry_in, v_carry_out, v_expected_amount
      using errcode = '23514';
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
  elsif v_batch.payee_kind = 'creator' then
    /*
      creator は対象月ごとに上の loop で確定させた。
      ここでは何もしない（締め月の1行に全額を寄せると月別と合わなくなる）。
    */
    null;
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
$function$;

-- ④ release: 取消・失敗で繰越を戻す ------------------------------------------
create or replace function public.release_payment_batch_items(p_batch_id uuid, p_payee_kind text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  elsif p_payee_kind = 'creator' then
    select count(*) into v_paid_items
      from public.creator_lending_reward_items
     where payment_batch_id = p_batch_id and is_paid = true;
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
  /*
    --- 端末貸し出しの繰越を claim 前へ戻す -------------------------------------

    取消・振込失敗では振込が起きていないので、claim 時に取り込んだ
    繰越残高を元の値へ戻す。差額を引くのではなく balance_before へ
    戻すので、何度呼ばれても結果は同じになる。

    reverted の履歴は unique (payment_batch_id, action) で1回しか入らない。
    その insert が実際に成立したときだけ残高を戻す（二重復元を防ぐ）。
  */
  if p_payee_kind = 'creator' then
    with applied as (
      select cl.* from public.creator_lending_carryover_logs cl
       where cl.payment_batch_id = p_batch_id
         and cl.action = 'applied'
    ), reverted as (
      insert into public.creator_lending_carryover_logs (
        creator_id, payment_batch_id, action,
        carryover_in, carryover_out, items_amount, transfer_amount,
        balance_before, balance_after
      )
      select a.creator_id, p_batch_id, 'reverted',
             a.carryover_in, a.carryover_out, a.items_amount, a.transfer_amount,
             a.balance_after, a.balance_before
        from applied a
      on conflict (payment_batch_id, action) do nothing
      returning creator_id, balance_after as restore_to
    )
    update public.creator_lending_carryovers c
       set balance = r.restore_to,
           updated_at = now()
      from reverted r
     where c.creator_id = r.creator_id;
  end if;

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
  elsif p_payee_kind = 'creator' then
    with c as (
      update public.creator_lending_reward_items
         set payment_batch_id = null, updated_at = now()
       where payment_batch_id = p_batch_id
         and is_paid = false
      returning 1
    )
    select count(*) into v_released from c;
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
$function$;

-- ⑤ creator 受取種別に対応しているかを画面から確かめる関数（M-6） ------------
/*
  ③（payee_creator_id 列）と ④（支払RPC）とこの migration まで適用済みか。

  画面は「支払明細を作成」ボタンを出す前にこれを呼ぶ。
  関数そのものが無い環境（未適用）では呼び出しが失敗するので、
  アプリ側はその場合も「未対応」として扱う（fail-closed）。

  判定は実際の定義を見る。
    ・payment_batches.payee_creator_id 列がある
    ・claim_payment_batch_items が creator_lending_reward_items を占有する
    ・claim_payment_batch_items が繰越（creator_lending_carryovers）を扱う
    ・繰越テーブルがある
*/
create or replace function public.payment_batch_supports_creator()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select
    exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'payment_batches'
         and column_name = 'payee_creator_id'
    )
    and exists (
      select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = 'claim_payment_batch_items'
         and p.prosrc like '%creator_lending_reward_items%'
         and p.prosrc like '%creator_lending_carryovers%'
    )
    and exists (
      select 1 from pg_class c
        join pg_namespace n2 on n2.oid = c.relnamespace
       where n2.nspname = 'public'
         and c.relname = 'creator_lending_carryovers'
         and c.relkind = 'r'
    );
$fn$;

comment on function public.payment_batch_supports_creator() is
  '支払経路がクリエイター本人（端末貸し出し報酬）に対応しているか。payee_creator_id 列・claim の creator 分岐・繰越テーブルがすべて揃っていれば true。画面の操作可否の判定に使う。';

revoke all on function public.payment_batch_supports_creator() from public;
grant execute on function public.payment_batch_supports_creator() to authenticated, service_role;
