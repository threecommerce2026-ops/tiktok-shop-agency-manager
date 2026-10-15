-- =============================================================================
-- 端末貸し出し報酬（本人受取）の専用テーブル
-- =============================================================================
/*
  ■ 業務ルール（2026-10-10 確定）
  管理区分 account_management_type = 'account_lending' のクリエイターは、
  所属が THREE.inc（自社）のまま、AK（agency_split_rate）も 100% のままで、
  AP（affiliate_order_lines.agency_revenue）を本人と自社で分ける。

      本人      = AP × 分配率（基本 80%）
      THREE.inc = AP − 本人報酬

  紹介者報酬5%とは別制度。account_lending は従来どおり5%の対象外。

  ■ なぜ専用テーブルにするのか
  受取人がクリエイター本人なので、既存の報酬明細には入れられない。

    agency_reward_items.agency_id    not null + FK → agencies(id)
      → creator_id を入れると FK 違反、null も not null 違反（実測で確認）
    referral_reward_items.referrer_id  not null + FK → referrers(id)
      → 同様に本人を入れられない

  本人を架空の代理店として登録したり、THREE.inc の代理店 ID で代用したりは
  しない（支払先が不明確になるため禁止）。本人は creators.id で指す。

  ■ 所属・区分・AK は変更しない
  このテーブル群は creator_monthly_agency_assignments（所属）と
  creator_monthly_account_management_types（区分）と
  affiliate_order_lines.agency_split_rate（AK）を「読むだけ」。
  計算の前提条件として検証するだけで、1行も書き換えない。

  ■ DML は 0 件
  テーブル・索引・制約・RLS・ポリシーの作成のみ。既存データには触らない。

  ■ 既に適用済みの migration との関係
    20261009120000  agency_reward_items に reward_kind / lending_split_rate を追加
    20261009130000  agency_reward_items のガード
  どちらも改変しない。20261009130000 のガードは別の差分 migration で
  「agency_reward_items に account_lending を入れさせない」形へ置き換える。
*/

-- ① 口座情報 ------------------------------------------------------------------
/*
  本人への振込先。creators には口座列が無いため新設する。

  口座は creators 本体に持たせず別テーブルにする。
    ・口座が必要なのは貸し出し対象の数名だけ（creators は 489 行）
    ・列レベルで権限を絞れる（referrers の bank_* と同じ考え方）
    ・通常の画面・ログに口座が混ざらない

  RLS は管理者のみ。authenticated には SELECT も渡さない。
*/
create table if not exists public.creator_bank_accounts (
  creator_id uuid primary key references public.creators(id) on delete cascade,
  bank_name text,
  bank_code text,
  bank_branch_name text,
  bank_branch_code text,
  bank_account_type text,
  bank_account_number text,
  bank_account_holder text,
  updated_by uuid,
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.creator_bank_accounts is
  'クリエイター本人の振込先。端末貸し出し報酬の支払に使う。管理者のみ参照・更新できる（authenticated には権限を渡さない）。';

alter table public.creator_bank_accounts enable row level security;

drop policy if exists "creator_bank_accounts_admin_all" on public.creator_bank_accounts;
create policy "creator_bank_accounts_admin_all"
  on public.creator_bank_accounts for all to public
  using (public.is_app_admin())
  with check (public.is_app_admin());

revoke all on public.creator_bank_accounts from authenticated, anon;
grant all on public.creator_bank_accounts to service_role;

-- ② 分配条件（本人×対象月） ---------------------------------------------------
/*
  本人ごと・対象月ごとの分配率と有効化。

  ■ 未設定時の扱いと「確定条件」を分けて持つ
    split_rate      null なら既定 80%（アプリ側の単一定数を使う）
    is_active       この月に端末貸し出し報酬を発生させるか
                    false / 行が無い → 報酬を作らない

  「区分が account_lending であること」「所属が自社であること」「AK が 100%」は
  別テーブル（区分・所属・注文明細）が持つ事実なので、ここには複製しない。
  このテーブルが持つのは「その月に本人へ分配する運用上の決定」だけ。
*/
create table if not exists public.creator_lending_terms (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  target_month text not null,
  /* null なら既定 80%。0 < rate <= 1 の範囲だけ保存できる */
  split_rate numeric,
  is_active boolean not null default true,
  note text,
  created_by uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id, target_month),
  constraint creator_lending_terms_month_format_check
    check (target_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint creator_lending_terms_split_rate_range_check
    check (split_rate is null or (split_rate > 0 and split_rate <= 1))
);

comment on table public.creator_lending_terms is
  '端末貸し出し報酬の分配条件（本人×対象月）。split_rate が null なら既定 80%。is_active=false または行が無い月は報酬を作らない。区分・所属・AK はここには複製せず、それぞれの正データを読む。';
comment on column public.creator_lending_terms.split_rate is
  '本人の分配率（0 < rate <= 1）。null なら既定 80%。';
comment on column public.creator_lending_terms.is_active is
  'この月に端末貸し出し報酬を発生させるか。false なら作らない。';

create index if not exists creator_lending_terms_month_idx
  on public.creator_lending_terms (target_month);
create index if not exists creator_lending_terms_active_idx
  on public.creator_lending_terms (creator_id, target_month) where is_active;

alter table public.creator_lending_terms enable row level security;

drop policy if exists "creator_lending_terms_admin_all" on public.creator_lending_terms;
create policy "creator_lending_terms_admin_all"
  on public.creator_lending_terms for all to public
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "creator_lending_terms_select_admin" on public.creator_lending_terms;
create policy "creator_lending_terms_select_admin"
  on public.creator_lending_terms for select to public
  using (public.is_app_admin());

grant select on public.creator_lending_terms to authenticated;
grant all on public.creator_lending_terms to service_role;

-- ③ 分配条件の変更履歴 --------------------------------------------------------
create table if not exists public.creator_lending_term_logs (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null,
  target_month text not null,
  action text not null,
  from_split_rate numeric,
  to_split_rate numeric,
  from_is_active boolean,
  to_is_active boolean,
  note text,
  changed_by uuid,
  changed_by_email text,
  created_at timestamptz not null default now(),
  constraint creator_lending_term_logs_action_check
    check (action in ('set_rate', 'reset_rate', 'activate', 'deactivate'))
);

comment on table public.creator_lending_term_logs is
  '端末貸し出しの分配条件の変更履歴（監査用）。追記専用。';

create index if not exists creator_lending_term_logs_creator_idx
  on public.creator_lending_term_logs (creator_id, target_month);

alter table public.creator_lending_term_logs enable row level security;

drop policy if exists "creator_lending_term_logs_admin_all" on public.creator_lending_term_logs;
create policy "creator_lending_term_logs_admin_all"
  on public.creator_lending_term_logs for all to public
  using (public.is_app_admin())
  with check (public.is_app_admin());

grant select, insert on public.creator_lending_term_logs to authenticated;
grant all on public.creator_lending_term_logs to service_role;

-- ④ 報酬明細（注文明細単位） --------------------------------------------------
/*
  受取人は creator_id。1注文明細（source_row_key）につき1行。

  source_row_key を UNIQUE にして upsert するため、何度再集計しても
  二重計上しない（agency_reward_items / referral_reward_items と同じ方式）。

  AP・AK・適用分配率・本人報酬・自社取り分をすべて保存する。
  既定の分配率を後から変えても、過去の支払根拠が明細から辿れる。
*/
create table if not exists public.creator_lending_reward_items (
  id uuid primary key default gen_random_uuid(),
  source_row_key text not null unique,
  target_month text not null,
  reward_year text generated always as (left(target_month, 4)) stored,
  order_id text not null default '',
  product_id text not null default '',
  /* 受取人。本人そのもの */
  creator_id uuid not null references public.creators(id) on delete cascade,
  /* 検証時点の自社所属。監査用に記録する（支払先ではない） */
  in_house_agency_id uuid references public.agencies(id) on delete set null,
  /* 計算元 */
  commission_base numeric not null default 0,
  commission_gmv numeric not null default 0,
  creator_revenue_before_split numeric not null default 0,
  agency_split_rate numeric not null default 0,
  agency_revenue numeric not null default 0,
  /* 適用した分配率と結果 */
  split_rate numeric not null,
  reward_amount numeric not null default 0,
  self_share_amount numeric not null default 0,
  /* 対象判定に使った注文のステータス */
  payment_status text,
  order_status text,
  refund_status text,
  is_reward_target boolean not null default true,
  is_paid boolean not null default false,
  paid_at timestamptz,
  payout_id uuid,
  payment_batch_id uuid references public.payment_batches(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_lending_reward_items_month_format_check
    check (target_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint creator_lending_reward_items_split_rate_range_check
    check (split_rate > 0 and split_rate <= 1),
  /* 本人 + 自社 = AP を DB でも守る（1銭の丸め差まで許容） */
  constraint creator_lending_reward_items_share_sum_check
    check (abs((reward_amount + self_share_amount) - agency_revenue) <= 0.01)
);

comment on table public.creator_lending_reward_items is
  '端末貸し出し報酬の明細（受取人はクリエイター本人）。AP × split_rate が本人報酬、残りが自社取り分。source_row_key で一意なので再集計しても二重計上しない。';
comment on column public.creator_lending_reward_items.in_house_agency_id is
  '計算時点の自社所属（THREE.inc）。監査用の記録で、支払先ではない。';
comment on column public.creator_lending_reward_items.self_share_amount is
  'THREE.inc の取り分（AP − 本人報酬）。分配率を後から変えても根拠が残るよう保存する。';

create index if not exists creator_lending_reward_items_creator_idx
  on public.creator_lending_reward_items (creator_id);
create index if not exists creator_lending_reward_items_month_idx
  on public.creator_lending_reward_items (target_month);
create index if not exists creator_lending_reward_items_annual_idx
  on public.creator_lending_reward_items (creator_id, reward_year, is_paid, is_reward_target);
create index if not exists creator_lending_reward_items_claimable_idx
  on public.creator_lending_reward_items (creator_id, target_month)
  where is_reward_target and not is_paid and payout_id is null and payment_batch_id is null;
create index if not exists creator_lending_reward_items_payment_batch_idx
  on public.creator_lending_reward_items (payment_batch_id);
create index if not exists creator_lending_reward_items_payout_idx
  on public.creator_lending_reward_items (payout_id);

alter table public.creator_lending_reward_items enable row level security;

drop policy if exists "creator_lending_reward_items_admin_all" on public.creator_lending_reward_items;
create policy "creator_lending_reward_items_admin_all"
  on public.creator_lending_reward_items for all to public
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "creator_lending_reward_items_select_admin" on public.creator_lending_reward_items;
create policy "creator_lending_reward_items_select_admin"
  on public.creator_lending_reward_items for select to public
  using (public.is_app_admin());

grant select on public.creator_lending_reward_items to authenticated;
grant all on public.creator_lending_reward_items to service_role;

-- ⑤ 支払予定（本人×対象月） --------------------------------------------------
/*
  既存の agency_payouts / referral_payouts と同じ形にする。
  unique (target_month, creator_id) で upsert するため、
  再計算しても行が増えない（二重計上しない）。
*/
create table if not exists public.creator_lending_payouts (
  id uuid primary key default gen_random_uuid(),
  target_month text not null,
  reward_year text generated always as (left(target_month, 4)) stored,
  creator_id uuid not null references public.creators(id) on delete cascade,
  total_reward_amount numeric not null default 0,
  total_self_share_amount numeric not null default 0,
  threshold_amount numeric not null default 0,
  is_payable boolean not null default false,
  status text not null default 'unpaid',
  paid_at timestamptz,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (target_month, creator_id),
  constraint creator_lending_payouts_month_format_check
    check (target_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint creator_lending_payouts_status_check
    check (status in ('hold', 'unpaid', 'paid'))
);

comment on table public.creator_lending_payouts is
  '端末貸し出し報酬の支払予定（本人×対象月）。target_month + creator_id で一意なので再計算しても二重計上しない。';

create index if not exists creator_lending_payouts_creator_idx
  on public.creator_lending_payouts (creator_id, reward_year);

alter table public.creator_lending_payouts enable row level security;

drop policy if exists "creator_lending_payouts_admin_all" on public.creator_lending_payouts;
create policy "creator_lending_payouts_admin_all"
  on public.creator_lending_payouts for all to public
  using (public.is_app_admin())
  with check (public.is_app_admin());

drop policy if exists "creator_lending_payouts_select_admin" on public.creator_lending_payouts;
create policy "creator_lending_payouts_select_admin"
  on public.creator_lending_payouts for select to public
  using (public.is_app_admin());

grant select on public.creator_lending_payouts to authenticated;
grant all on public.creator_lending_payouts to service_role;

/* 明細 → 支払予定の紐付け（支払予定を作ったあとに張る） */
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.creator_lending_reward_items'::regclass
       and conname = 'creator_lending_reward_items_payout_id_fkey'
  ) then
    alter table public.creator_lending_reward_items
      add constraint creator_lending_reward_items_payout_id_fkey
      foreign key (payout_id) references public.creator_lending_payouts(id) on delete set null;
  end if;
end $$;
