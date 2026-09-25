-- =============================================================================
-- 支払明細の状態遷移 RPC
-- =============================================================================
-- 非破壊方針:
--   ・既存関数（mark_agency_payout_paid_annual 等）は変更・削除しない
--   ・追加するのは CREATE FUNCTION のみ
--
-- 共通ルール:
--   ・SECURITY DEFINER + set search_path = public（検索パス固定）
--   ・先頭で必ず public.is_app_admin() を検証する
--   ・payment_batches を for update でロックしてから状態を判定する
--   ・入力（payee_kind / 対象月形式 / 期間の前後）を必ず検証する
--
-- 二重支払い防止の中核:
--   報酬明細の占有は payment_batch_id ただ1カラム。
--   claim の WHERE に
--     is_reward_target = true / is_paid = false /
--     payout_id is null / payment_batch_id is null
--   の4条件を必ず入れる。同じ明細が2つの支払明細へ入ることは構造上起きない。
--
-- is_paid を true にするのは complete_payment_batch だけ。
-- 作成・承認・CSV出力では絶対に変更しない。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0-a. 監査ログの共通書き込み
-- -----------------------------------------------------------------------------
create or replace function public.log_payment_batch_action(
  p_batch_id uuid,
  p_action text,
  p_from_status text,
  p_to_status text,
  p_item_count integer,
  p_amount numeric,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payment_batch_audit_logs (
    batch_id, action, from_status, to_status,
    item_count, amount, actor_id, actor_email, note
  )
  values (
    p_batch_id, p_action, p_from_status, p_to_status,
    p_item_count, p_amount, auth.uid(),
    (select u.email from auth.users u where u.id = auth.uid()),
    p_note
  );
end;
$$;

comment on function public.log_payment_batch_action(uuid, text, text, text, integer, numeric, text) is
  '支払明細の操作を payment_batch_audit_logs へ記録する内部ヘルパー。';

-- -----------------------------------------------------------------------------
-- 0-b. 占有の解放（失敗・取消の共通処理）
-- -----------------------------------------------------------------------------
-- 支払済み（is_paid = true）の明細は絶対に未払いへ戻さない。
-- 戻すべきでない行が混ざっていたら、解放せず例外で中止する。
create or replace function public.release_payment_batch_items(
  p_batch_id uuid,
  p_payee_kind text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid_items integer := 0;
  v_released integer := 0;
begin
  if p_payee_kind = 'agency' then
    select count(*) into v_paid_items
      from public.agency_reward_items
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

  if p_payee_kind = 'agency' then
    update public.agency_reward_items
       set payment_batch_id = null, updated_at = now()
     where payment_batch_id = p_batch_id
       and is_paid = false;
  else
    update public.referral_reward_items
       set payment_batch_id = null, updated_at = now()
     where payment_batch_id = p_batch_id
       and is_paid = false;
  end if;

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

comment on function public.release_payment_batch_items(uuid, text) is
  '支払明細が占有していた報酬明細を未払いへ戻す。支払済みが混ざっていれば中止する。';

-- -----------------------------------------------------------------------------
-- 1. 支払明細の作成 + 対象明細の占有（1トランザクション）
-- -----------------------------------------------------------------------------
-- p_min_amount は支払基準額。紹介者の 1,000円 は環境変数で変えられるため
-- 呼び出し側（TypeScript）が単一ソースとして渡す。ここでは受け取った値を
-- 原子的に検証するだけで、独自のしきい値は持たない。
create or replace function public.claim_payment_batch_items(
  p_payee_kind text,
  p_payee_id uuid,
  p_period_start_month text,
  p_period_end_month text,
  p_min_amount numeric default 0,
  p_memo text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_count integer := 0;
  v_amount numeric := 0;
  v_is_in_house boolean := false;
  v_payee_name text;
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

  if v_is_in_house then
    raise exception '「%」は自社です。外部への支払対象ではありません', v_payee_name
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
$$;

comment on function public.claim_payment_batch_items(text, uuid, text, text, numeric, text) is
  '未払いの報酬明細を占有して支払明細（draft）を作る。is_paid は変更しない。';

-- -----------------------------------------------------------------------------
-- 2. 承認（振込先スナップショットの確定）
-- -----------------------------------------------------------------------------
create or replace function public.approve_payment_batch(
  p_batch_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
begin
  if not public.is_app_admin() then
    raise exception '支払明細の承認は親管理者のみ実行できます' using errcode = '42501';
  end if;

  select * into v_batch from public.payment_batches where id = p_batch_id for update;

  if not found then
    raise exception '支払明細が見つかりません' using errcode = '23503';
  end if;

  if v_batch.status <> 'draft' then
    raise exception '承認できるのは下書きの支払明細だけです（現在: %）', v_batch.status
      using errcode = '22023';
  end if;

  -- 承認時点の振込先を複写して固定する。
  -- 以後マスタ側の口座が変わっても、この支払明細の振込先は変わらない。
  if v_batch.payee_kind = 'agency' then
    select a.name,
           a.bank_name, a.bank_code, a.bank_branch_name, a.bank_branch_code,
           a.bank_account_type, a.bank_account_number, a.bank_account_holder
      into v_payee_name,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder
      from public.agencies a where a.id = v_batch.agency_id;
  else
    select coalesce(r.referrer_name, r.name),
           r.bank_name, r.bank_code, r.bank_branch_name, r.bank_branch_code,
           r.bank_account_type, r.bank_account_number, r.bank_account_holder
      into v_payee_name,
           v_bank_name, v_bank_code, v_branch_name, v_branch_code,
           v_account_type, v_account_number, v_account_holder
      from public.referrers r where r.id = v_batch.referrer_id;
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
$$;

comment on function public.approve_payment_batch(uuid) is
  '支払明細を承認し、振込先をスナップショットとして固定する。is_paid は変更しない。';

-- -----------------------------------------------------------------------------
-- 3. 振込中（銀行へ送信済み）
-- -----------------------------------------------------------------------------
create or replace function public.set_payment_batch_processing(
  p_batch_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.payment_batches%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  select * into v_batch from public.payment_batches where id = p_batch_id for update;

  if not found then
    raise exception '支払明細が見つかりません' using errcode = '23503';
  end if;

  if v_batch.status <> 'approved' then
    raise exception '振込中にできるのは承認済みの支払明細だけです（現在: %）', v_batch.status
      using errcode = '22023';
  end if;

  update public.payment_batches
     set status = 'processing', updated_at = now()
   where id = p_batch_id;

  perform public.log_payment_batch_action(
    p_batch_id, 'processing', 'approved', 'processing',
    v_batch.item_count, v_batch.payment_amount, null
  );
end;
$$;

comment on function public.set_payment_batch_processing(uuid) is
  '承認済みの支払明細を振込中にする。is_paid は変更しない。';

-- -----------------------------------------------------------------------------
-- 4. 振込完了（ここで初めて支払済みになる）
-- -----------------------------------------------------------------------------
create or replace function public.complete_payment_batch(
  p_batch_id uuid,
  p_paid_on date default null,
  p_memo text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.payment_batches%rowtype;
  v_paid_at timestamptz := now();
  v_today date;
  v_paid_on date;
  v_count integer := 0;
  v_amount numeric := 0;
  v_payout_id uuid;
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

    update public.agency_reward_items
       set is_paid = true,
           paid_at = v_paid_at,
           payout_id = v_payout_id,
           updated_at = v_paid_at
     where payment_batch_id = p_batch_id
       and is_paid = false;

    get diagnostics v_count = row_count;

    select coalesce(sum(reward_amount), 0) into v_amount
      from public.agency_reward_items
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

    update public.referral_reward_items
       set is_paid = true,
           paid_at = v_paid_at,
           payout_id = v_payout_id,
           updated_at = v_paid_at
     where payment_batch_id = p_batch_id
       and is_paid = false;

    get diagnostics v_count = row_count;

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

  -- 紹介者は生涯上限の判定元（累計支払額）も更新する
  if v_batch.payee_kind = 'referrer' then
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
  end if;

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
$$;

comment on function public.complete_payment_batch(uuid, date, text) is
  '実際の銀行振込が完了した後に呼ぶ。ここで初めて報酬明細が支払済みになる。';

-- -----------------------------------------------------------------------------
-- 5. 振込失敗
-- -----------------------------------------------------------------------------
create or replace function public.fail_payment_batch(
  p_batch_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.payment_batches%rowtype;
  v_released integer := 0;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  select * into v_batch from public.payment_batches where id = p_batch_id for update;

  if not found then
    raise exception '支払明細が見つかりません' using errcode = '23503';
  end if;

  if v_batch.status = 'paid' then
    raise exception '振込完了済みの支払明細は失敗にできません' using errcode = '22023';
  end if;

  if v_batch.status not in ('approved', 'processing') then
    raise exception '失敗を登録できるのは承認済み / 振込中の支払明細だけです（現在: %）',
      v_batch.status using errcode = '22023';
  end if;

  v_released := public.release_payment_batch_items(p_batch_id, v_batch.payee_kind);

  update public.payment_batches
     set status = 'failed',
         failure_reason = p_reason,
         updated_at = now()
   where id = p_batch_id;

  perform public.log_payment_batch_action(
    p_batch_id, 'failed', v_batch.status, 'failed',
    v_released, v_batch.payment_amount, p_reason
  );
end;
$$;

comment on function public.fail_payment_batch(uuid, text) is
  '振込失敗を登録し、占有していた報酬明細を未払いへ戻す。支払済みは失敗にできない。';

-- -----------------------------------------------------------------------------
-- 6. 取消
-- -----------------------------------------------------------------------------
create or replace function public.cancel_payment_batch(
  p_batch_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.payment_batches%rowtype;
  v_released integer := 0;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  select * into v_batch from public.payment_batches where id = p_batch_id for update;

  if not found then
    raise exception '支払明細が見つかりません' using errcode = '23503';
  end if;

  if v_batch.status = 'paid' then
    raise exception '振込完了済みの支払明細は取り消せません' using errcode = '22023';
  end if;

  if v_batch.status in ('failed', 'cancelled') then
    raise exception 'この支払明細は既に % です', v_batch.status using errcode = '22023';
  end if;

  v_released := public.release_payment_batch_items(p_batch_id, v_batch.payee_kind);

  update public.payment_batches
     set status = 'cancelled',
         failure_reason = p_reason,
         updated_at = now()
   where id = p_batch_id;

  perform public.log_payment_batch_action(
    p_batch_id, 'cancelled', v_batch.status, 'cancelled',
    v_released, v_batch.payment_amount, p_reason
  );
end;
$$;

comment on function public.cancel_payment_batch(uuid, text) is
  '支払明細を取り消し、占有していた報酬明細を未払いへ戻す。支払済みは取り消せない。';

-- -----------------------------------------------------------------------------
-- 7. CSV出力の記録
-- -----------------------------------------------------------------------------
create or replace function public.log_payment_batch_csv_export(
  p_batch_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.payment_batches%rowtype;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  select * into v_batch from public.payment_batches where id = p_batch_id;

  if not found then
    raise exception '支払明細が見つかりません' using errcode = '23503';
  end if;

  perform public.log_payment_batch_action(
    p_batch_id, 'csv_exported', v_batch.status, v_batch.status,
    v_batch.item_count, v_batch.payment_amount, null
  );
end;
$$;

comment on function public.log_payment_batch_csv_export(uuid) is
  '振込用CSVを出力したことを監査ログへ記録する。';

-- -----------------------------------------------------------------------------
-- 8. 実行権限
-- -----------------------------------------------------------------------------
-- 内部ヘルパーは直接呼ばせない（authenticated へ grant しない）
revoke all on function public.log_payment_batch_action(uuid, text, text, text, integer, numeric, text) from public;
revoke all on function public.release_payment_batch_items(uuid, text) from public;

revoke all on function public.claim_payment_batch_items(text, uuid, text, text, numeric, text) from public;
revoke all on function public.approve_payment_batch(uuid) from public;
revoke all on function public.set_payment_batch_processing(uuid) from public;
revoke all on function public.complete_payment_batch(uuid, date, text) from public;
revoke all on function public.fail_payment_batch(uuid, text) from public;
revoke all on function public.cancel_payment_batch(uuid, text) from public;
revoke all on function public.log_payment_batch_csv_export(uuid) from public;

grant execute on function public.claim_payment_batch_items(text, uuid, text, text, numeric, text) to authenticated;
grant execute on function public.approve_payment_batch(uuid) to authenticated;
grant execute on function public.set_payment_batch_processing(uuid) to authenticated;
grant execute on function public.complete_payment_batch(uuid, date, text) to authenticated;
grant execute on function public.fail_payment_batch(uuid, text) to authenticated;
grant execute on function public.cancel_payment_batch(uuid, text) to authenticated;
grant execute on function public.log_payment_batch_csv_export(uuid) to authenticated;
