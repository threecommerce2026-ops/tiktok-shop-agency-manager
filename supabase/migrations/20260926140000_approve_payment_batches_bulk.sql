/*
  支払明細の一括承認。

  ■ 承認ロジックを二重に持たない
  単体承認 approve_payment_batch も、一括承認 approve_payment_batches_bulk も、
  同じ approve_one_payment_batch() を呼ぶ。validation・振込先の固定・
  status 遷移・監査ログの挙動が単体と一括でズレないようにする。

  ■ 全件成功か全件失敗
  一括承認は1トランザクション。1件でも検証に失敗したら raise exception で
  全件ロールバックする。部分的に承認された状態を作らない。

  ■ 代理店へ支払うのは代理店分配報酬だけ
  紹介制度報酬は代理店へ支払わない。占有されている紹介報酬が1件でもあれば
  承認を止める（旧仕様で作られた明細を誤って承認しないため）。
  取消済みの過去明細には影響しない。承認対象は draft だけ。

  ■ 締め対象月は揃えて承認する
  締め月が違う明細を一度に承認すると、どの締めを承認したのか追えなくなる。
  混在していたら止める。

  ■ 二重押下
  status = 'draft' 以外は承認しない。同じ明細を2回送っても2回目は
  「下書きではない」で止まるため、二重承認も監査ログの重複も起きない。
*/

-- ---------------------------------------------------------------------------
-- 1件分の承認（単体・一括の共通処理）
-- ---------------------------------------------------------------------------
create or replace function public.approve_one_payment_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
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
$fn$;

-- ---------------------------------------------------------------------------
-- 単体承認（既存の入口。中身を共通処理へ委譲する）
-- ---------------------------------------------------------------------------
create or replace function public.approve_payment_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_app_admin() then
    raise exception '支払明細の承認は親管理者のみ実行できます' using errcode = '42501';
  end if;

  perform public.approve_one_payment_batch(p_batch_id);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 一括承認
-- ---------------------------------------------------------------------------
create or replace function public.approve_payment_batches_bulk(p_batch_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ids uuid[];
  v_requested integer;
  v_found integer;
  v_cutoffs integer;
  v_id uuid;
  v_approved integer := 0;
  v_max_batches constant integer := 100;
begin
  if not public.is_app_admin() then
    raise exception '支払明細の承認は親管理者のみ実行できます' using errcode = '42501';
  end if;

  if p_batch_ids is null then
    raise exception '支払明細を指定してください' using errcode = '22023';
  end if;

  -- 重複排除と NULL 除去
  select array_agg(distinct x) into v_ids
    from unnest(p_batch_ids) as t(x) where x is not null;

  v_requested := coalesce(array_length(v_ids, 1), 0);

  if v_requested = 0 then
    raise exception '支払明細を1件以上選択してください' using errcode = '22023';
  end if;

  if v_requested > v_max_batches then
    raise exception '一度に承認できる支払明細は % 件までです（指定 % 件）',
      v_max_batches, v_requested using errcode = '22023';
  end if;

  /*
    存在確認と締め月の検証は、1件でも承認する前にまとめて行う。
    lock は共通処理の for update に任せる。
  */
  select count(*) into v_found from public.payment_batches where id = any(v_ids);
  if v_found <> v_requested then
    raise exception '存在しない支払明細が含まれています（指定 % 件 / 実在 % 件）',
      v_requested, v_found using errcode = '23503';
  end if;

  select count(distinct cutoff_month) into v_cutoffs
    from public.payment_batches where id = any(v_ids);
  if v_cutoffs > 1 then
    raise exception '締め対象月が異なる支払明細は同時に承認できません（% 種類）', v_cutoffs
      using errcode = '22023';
  end if;

  -- 金額の大きい順に承認する（監査ログの並びを人が追いやすくするため）
  for v_id in
    select id from public.payment_batches
     where id = any(v_ids)
     order by payment_amount desc, id
  loop
    perform public.approve_one_payment_batch(v_id);
    v_approved := v_approved + 1;
  end loop;

  if v_approved <> v_requested then
    raise exception '承認件数が指定件数と一致しません（指定 % 件 / 承認 % 件）',
      v_requested, v_approved using errcode = '23514';
  end if;

  return v_approved;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 権限
--
-- 関数は作成時に PUBLIC へ EXECUTE が付くので、先に落としてから付け直す。
-- 既存の遷移系 RPC（approve / cancel / complete など）と同じ
-- 「anon は不可 / authenticated のみ」に揃える。
-- いずれも SECURITY DEFINER で、中で is_app_admin() を必ず確認している。
-- ---------------------------------------------------------------------------

-- 共通処理は直接呼ばせない（admin 判定を通さずに承認されないようにする）
revoke all on function public.approve_one_payment_batch(uuid) from public, anon, authenticated;

revoke all on function public.approve_payment_batches_bulk(uuid[]) from public, anon;
grant execute on function public.approve_payment_batches_bulk(uuid[]) to authenticated;
