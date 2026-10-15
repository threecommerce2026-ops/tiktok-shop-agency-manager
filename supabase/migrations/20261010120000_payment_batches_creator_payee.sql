-- =============================================================================
-- 支払経路に第3の受取種別「creator」を追加する
-- =============================================================================
/*
  ■ 追加する受取種別
      agency    既存の代理店
      referrer  既存の紹介者
      creator   端末貸し出し対象のクリエイター本人   ← 今回追加

  ■ 既存の動作は1ビットも変えない
  payee_kind = 'agency' / 'referrer' の経路は、列・制約・RPC すべて
  従来と同じ条件で通る。追加するのは
    ・payee_creator_id 列（null 許可）
    ・payee_kind の CHECK に 'creator' を足す
    ・排他制約を3択に広げる
  の3点だけ。

  ■ 排他制約の考え方（既存の形をそのまま3択へ）
      agency   → agency_id あり / referrer_id なし / payee_creator_id なし
      referrer → referrer_id あり / agency_id なし / payee_creator_id なし
      creator  → payee_creator_id あり / agency_id なし / referrer_id なし

  既存 18 行はすべて agency か referrer なので、広げた制約を満たす。

  ■ C-3 / C-3b との整合
  C-3（支払系RPCの支払対象外ガード）と C-3b（トリガ）は紹介者の
  is_referrer_payout_excluded() に基づくもので、referrer の経路にだけ効く。
  creator の経路を足しても、その判定には一切触れない。
  payment_batches のトリガ（payment_batches_payout_excluded_guard）は
  payee_kind='referrer' のときだけ発火する実装なので、
  creator の行には反応しない（適用後に実測で確認すること）。

  ■ DML は 0 件
*/

-- ① 受取人の列 ---------------------------------------------------------------
alter table public.payment_batches
  add column if not exists payee_creator_id uuid;

comment on column public.payment_batches.payee_creator_id is
  '端末貸し出し報酬の受取人（クリエイター本人）。payee_kind=''creator'' のときだけ値が入る。代理店・紹介者の支払では null。';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.payment_batches'::regclass
       and conname = 'payment_batches_payee_creator_id_fkey'
  ) then
    alter table public.payment_batches
      add constraint payment_batches_payee_creator_id_fkey
      foreign key (payee_creator_id) references public.creators(id) on delete restrict;
  end if;
end $$;

create index if not exists payment_batches_payee_creator_idx
  on public.payment_batches (payee_creator_id) where payee_creator_id is not null;

-- ② 受取種別の CHECK を3択へ --------------------------------------------------
do $$
begin
  /*
    既存の制約を落として作り直す。
    既存 18 行（agency / referrer）は新しい定義でも通る。
  */
  alter table public.payment_batches
    drop constraint if exists payment_batches_payee_kind_check;

  alter table public.payment_batches
    add constraint payment_batches_payee_kind_check
    check (payee_kind in ('agency', 'referrer', 'creator'));

  alter table public.payment_batches
    drop constraint if exists payment_batches_payee_exclusive_check;

  alter table public.payment_batches
    add constraint payment_batches_payee_exclusive_check
    check (
      (payee_kind = 'agency'
        and agency_id is not null and referrer_id is null and payee_creator_id is null)
      or (payee_kind = 'referrer'
        and referrer_id is not null and agency_id is null and payee_creator_id is null)
      or (payee_kind = 'creator'
        and payee_creator_id is not null and agency_id is null and referrer_id is null)
    );
end $$;

-- ③ 明細の占有を解放する関数に creator を足す --------------------------------
/*
  既存の agency / referrer の分岐は条件も SQL も変えない。
  creator の分岐を足すだけ。
*/
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
