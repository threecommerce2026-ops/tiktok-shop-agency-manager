-- =============================================================================
-- 支払系RPC に受取種別「creator」を追加する
-- =============================================================================
/*
  ■ 何をするか
  本番の現在の定義（pg_get_functiondef の出力）に creator の分岐を足して
  create or replace する。agency / referrer の既存分岐は条件も SQL も
  1文字も変えていない。

  ■ 対象の3関数
    claim_payment_batch_items   受取種別の検証 / 口座の取得 / 支払明細の作成 /
                                明細の占有に creator を追加
    approve_one_payment_batch   振込先の複写 / スナップショット照合に creator を追加
    complete_payment_batch      支払予定の紐付け / 明細の支払済化 /
                                支払予定の金額置き直しに creator を追加

  release_payment_batch_items は 20261010120000 で既に creator 対応済み。
  set_payment_batch_processing / cancel_payment_batch / fail_payment_batch は
  明細テーブルを直接触らず release 経由なので変更不要
  （payee_kind の参照はあるが分岐していないことを確認済み）。

  ■ creator の経路で守ること
    ・口座は creator_bank_accounts（本人専用テーブル）から引く
    ・占有するのは creator_lending_reward_items だけ
      WHERE の4条件（is_reward_target / is_paid / payout_id / payment_batch_id）は
      既存2種と同じ二重支払い防止で、緩めていない
    ・支払明細に代理店報酬・紹介報酬が混ざっていたら承認しない
    ・支払予定は creator_lending_payouts（本人×対象月）

  ■ C-3 / C-3b との整合
  紹介者の支払対象外ガード（is_referrer_payout_excluded）は
  payee_kind='referrer' の分岐内にあり、creator の経路からは呼ばれない。
  既存の判定条件には一切触れていない。

  ■ create or replace の性質
  所有者（postgres）と既存の GRANT は保持される。
  戻り値の型も引数も変えていないので、新しいオーバーロードは作られない。

  ■ DML は 0 件
*/

-- ---------------------------------------------------------------------------
-- claim_payment_batch_items
-- ---------------------------------------------------------------------------
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
$function$;

-- ---------------------------------------------------------------------------
-- approve_one_payment_batch
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- complete_payment_batch
-- ---------------------------------------------------------------------------
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
      本人×対象月の支払予定（creator_lending_payouts）に紐付ける。
      既にあれば再利用するので、再計算でも二重に作らない。
    */
    select id into v_payout_id
      from public.creator_lending_payouts
     where target_month = v_batch.period_end_month
       and creator_id = v_batch.payee_creator_id
     for update;

    if v_payout_id is null then
      insert into public.creator_lending_payouts (
        target_month, creator_id, threshold_amount, is_payable, status
      )
      values (v_batch.period_end_month, v_batch.payee_creator_id, 0, true, 'unpaid')
      returning id into v_payout_id;
    end if;

    with updated as (
      update public.creator_lending_reward_items
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
      from public.creator_lending_reward_items
     where payment_batch_id = p_batch_id;
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
  elsif v_batch.payee_kind = 'creator' then
    update public.creator_lending_payouts
       set total_reward_amount = (
             select coalesce(sum(reward_amount), 0)
               from public.creator_lending_reward_items
              where payout_id = v_payout_id
           ),
           total_self_share_amount = (
             select coalesce(sum(self_share_amount), 0)
               from public.creator_lending_reward_items
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
$function$;
