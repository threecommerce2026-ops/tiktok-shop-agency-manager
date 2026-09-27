/*
  紹介者報酬の「発生」と「支払」を分ける。

  ■ 業務ルール（2026-09-27 確定）
  紹介報酬が発生した事実と、実際に支払うかどうかは別管理にする。
  代理店所属（外部・自社いずれも）を理由に発生データを消したり
  reward_amount を 0 にしたりしない。支払うかどうかは EMI が決める。

  ■ 保存する状態は1つだけ
      payment_hold_reason IS NULL      手動の対象外ではない
      payment_hold_reason = manual_hold 今回は支払わない（EMIの判断）

  'agency_excluded' は作らない。外部代理店所属だからといって自動で
  支払対象外にはしないため、その理由コードは業務上存在しない。

  画面の「未判断 / 支払対象 / 今回は支払わない」は、この1列と
  既存の自動判定（閾値・口座・settlement・占有）の組み合わせで表せる。
  状態カラムを3つに増やすと、どれが正かが曖昧になる。

  ■ 発生データには触らない
  reward_amount / adjusted_reward_amount / base_amount / reward_rate /
  source_row_key / source_table / is_reward_target は一切変更しない。
  この migration が足すのは支払判断のメタデータだけ。

  ■ is_reward_target を流用しない理由
  is_reward_target は再集計のたびに (reward_amount > 0) で上書きされる。
  ここへ EMI の判断を入れると TAP 再集計で消える。
*/

alter table public.referral_reward_items
  add column if not exists payment_hold_reason text,
  add column if not exists payment_hold_set_by uuid references auth.users(id) on delete set null,
  add column if not exists payment_hold_set_at timestamptz;

/*
  payment_hold_set_at を持つ理由。
  誰が保留したか（set_by）だけでは「いつ判断したか」が残らない。
  支払は金銭の移動なので、締め月をまたいだ判断の前後関係を後から
  追えるようにしておく。payment_batch_audit_logs は batch_id を必須に
  するため、batch を作る前のこの操作は記録できない。
*/

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'referral_reward_items_payment_hold_reason_check'
  ) then
    alter table public.referral_reward_items
      add constraint referral_reward_items_payment_hold_reason_check
      check (payment_hold_reason is null or payment_hold_reason = 'manual_hold');
  end if;
end $$;

-- 保留されている明細だけを引く（大半は NULL なので部分索引にする）
create index if not exists referral_reward_items_payment_hold_idx
  on public.referral_reward_items (referrer_id, target_month)
  where payment_hold_reason is not null;

comment on column public.referral_reward_items.payment_hold_reason is
  '支払保留の理由。NULL=手動の対象外ではない / manual_hold=今回は支払わない（管理者の判断）。再集計で上書きしてはいけない。';
comment on column public.referral_reward_items.payment_hold_set_by is
  'manual_hold を設定した管理者。';
comment on column public.referral_reward_items.payment_hold_set_at is
  'manual_hold を設定した時刻。batch 作成前の操作は payment_batch_audit_logs に残せないため、ここで追跡する。';

-- -----------------------------------------------------------------------------
-- 手動保留の設定 / 解除
-- -----------------------------------------------------------------------------
/*
  対象は「その紹介者の、指定期間の、まだ誰にも占有されていない未払い明細」。

  支払済み・payout 紐付き・支払明細に占有中の明細には付けない。
  付けられてしまうと、支払明細の金額と実際に支払う額がずれる。
  解除も同じ条件にする（占有中の明細を勝手に外せないようにする）。
*/
create or replace function public.set_referral_payment_hold(
  p_referrer_id uuid,
  p_start_month text,
  p_cutoff_month text
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  if p_referrer_id is null then
    raise exception '紹介者を指定してください' using errcode = '22023';
  end if;

  if p_start_month is null or p_start_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception '開始月の形式が不正です（YYYY-MM）: %',
      coalesce(p_start_month, '(null)') using errcode = '22023';
  end if;

  if p_cutoff_month is null or p_cutoff_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception '締め対象月の形式が不正です（YYYY-MM）: %',
      coalesce(p_cutoff_month, '(null)') using errcode = '22023';
  end if;

  if p_start_month > p_cutoff_month then
    raise exception '開始月が締め対象月より後になっています（開始 % / 締め %）',
      p_start_month, p_cutoff_month using errcode = '22023';
  end if;

  update public.referral_reward_items
     set payment_hold_reason = 'manual_hold',
         payment_hold_set_by = auth.uid(),
         payment_hold_set_at = now(),
         updated_at = now()
   where referrer_id = p_referrer_id
     and target_month >= p_start_month
     and target_month <= p_cutoff_month
     -- 支払済み・占有中には付けない（支払明細の金額とずれる）
     and is_paid = false
     and payout_id is null
     and payment_batch_id is null
     and payment_hold_reason is null;

  get diagnostics v_count = row_count;

  return v_count;
end;
$fn$;

create or replace function public.clear_referral_payment_hold(
  p_referrer_id uuid,
  p_start_month text,
  p_cutoff_month text
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  if p_referrer_id is null then
    raise exception '紹介者を指定してください' using errcode = '22023';
  end if;

  if p_start_month is null or p_start_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception '開始月の形式が不正です（YYYY-MM）: %',
      coalesce(p_start_month, '(null)') using errcode = '22023';
  end if;

  if p_cutoff_month is null or p_cutoff_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception '締め対象月の形式が不正です（YYYY-MM）: %',
      coalesce(p_cutoff_month, '(null)') using errcode = '22023';
  end if;

  if p_start_month > p_cutoff_month then
    raise exception '開始月が締め対象月より後になっています（開始 % / 締め %）',
      p_start_month, p_cutoff_month using errcode = '22023';
  end if;

  update public.referral_reward_items
     set payment_hold_reason = null,
         payment_hold_set_by = null,
         payment_hold_set_at = null,
         updated_at = now()
   where referrer_id = p_referrer_id
     and target_month >= p_start_month
     and target_month <= p_cutoff_month
     and is_paid = false
     and payout_id is null
     and payment_batch_id is null
     and payment_hold_reason is not null;

  get diagnostics v_count = row_count;

  return v_count;
end;
$fn$;

revoke all on function public.set_referral_payment_hold(uuid, text, text) from public, anon;
revoke all on function public.clear_referral_payment_hold(uuid, text, text) from public, anon;
grant execute on function public.set_referral_payment_hold(uuid, text, text) to authenticated;
grant execute on function public.clear_referral_payment_hold(uuid, text, text) to authenticated;

comment on function public.set_referral_payment_hold(uuid, text, text) is
  '紹介報酬を「今回は支払わない」にする。支払済み・payout紐付き・支払明細に占有中の明細は対象外。設定件数を返す。';
comment on function public.clear_referral_payment_hold(uuid, text, text) is
  '紹介報酬の手動保留を解除する。条件は設定側と同じ。解除件数を返す。';

-- -----------------------------------------------------------------------------
-- claim の保護と legacy guard の解除
-- -----------------------------------------------------------------------------
/*
  ■ 変更点は3つだけ

  ① 紹介報酬の占有条件へ payment_hold_reason is null を追加
     既存の4条件（is_reward_target / is_paid / payout_id / payment_batch_id）は
     二重支払い防止そのもので、緩めていない。

  ② referrers.agency_id が入っていると紹介者claimを止めていた guard を削除
     紹介報酬は紹介者本人への報酬であり、referrers.agency_id は
     支払先を代理店へ変更する根拠にしない（2026-09-27 確定）。
     代理店側の処理には触らない。紹介報酬を代理店の支払へ混ぜない。
     referrers.agency_id 自体も残す（所属情報としては使う）。

  ③ 紹介者に対する is_in_house guard を削除
     （株）3 の紹介報酬も画面に出し、EMI が最終判断する。
     「表示する」と「自動で振り込む」は別。自社を自動で支払対象に
     するわけではなく、EMI が選ばなければ claim は起きない。
     代理店（payee_kind='agency'）側の is_in_house guard は残す。

  他の検証（締め月の形式・未来月・開始月・基準額・振込先の充足・
  settlement finalized・件数0・金額0）はすべて元のまま。
*/
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
as $function$
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

    紹介者側にはこの制限を掛けない。（株）3 の紹介報酬も発生データとして
    画面に出し、支払うかどうかは EMI が判断する。自社を自動で支払対象に
    するわけではなく、選ばれなければ claim は起きない。
  */
  if p_payee_kind = 'agency' and v_is_in_house then
    raise exception '「%」は自社です。外部への支払対象ではありません', v_payee_name
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
      触らない。
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

comment on function public.claim_payment_batch_items(text, uuid, text, text, numeric, text) is
  '支払明細を作成し対象の報酬明細を占有する。紹介報酬は payment_hold_reason is null のものだけを占有する。紹介者への支払は referrers.agency_id / is_in_house では止めない（表示と支払判断は別、EMIが選ぶ）。';
