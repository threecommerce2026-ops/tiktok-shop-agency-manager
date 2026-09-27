/*
  紹介者報酬の正データソースを TAP へ切り替えるための土台。

  ■ 業務ルール（2026-09-27 確定）
  紹介者報酬は tap_affiliate_order_lines だけを元に計算する。
  affiliate_order_lines は代理店報酬・売上集計で使い続けるが、
  紹介者報酬の計算元にはしない。両テーブルは同じ注文を別々のキーで
  持っているため、合算すると紹介者へ二重に支払うことになる。

  ■ このマイグレーションが行うこと
  1) referral_reward_items に出所（source_table）を持たせる
     既存行は affiliate 由来なので 'affiliate_order_lines' で埋める。
     以後 TAP から作られた行と、監査時に区別できるようにする。
  2) 月ごとの TAP 取込状況を持つ表を作る
     全量が入るまで紹介者の支払明細を作れないようにするための根拠。
  3) 旧 affiliate 由来の未払明細を TAP 由来へ置き換える関数
     使用済み（支払済 / claim済 / payout済）が1件でもあれば全体を中止する。

  ■ Production へはまだ適用しない
  TAP の全量（2026-01〜08）が入り、紹介報酬が確定してから適用する。
*/

-- -----------------------------------------------------------------------------
-- 1) 出所を記録する
-- -----------------------------------------------------------------------------
alter table public.referral_reward_items
  add column if not exists source_table text;

/*
  既存行はすべて affiliate_order_lines 由来（Production で 100% 追跡済み）。
  埋めてから NOT NULL にする。
*/
update public.referral_reward_items
   set source_table = 'affiliate_order_lines'
 where source_table is null;

alter table public.referral_reward_items
  alter column source_table set not null;

alter table public.referral_reward_items
  alter column source_table set default 'tap_affiliate_order_lines';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'referral_reward_items_source_table_check'
  ) then
    alter table public.referral_reward_items
      add constraint referral_reward_items_source_table_check
      check (source_table in ('affiliate_order_lines', 'tap_affiliate_order_lines'));
  end if;
end $$;

create index if not exists referral_reward_items_source_table_idx
  on public.referral_reward_items (source_table, target_month);

comment on column public.referral_reward_items.source_table is
  '紹介者報酬の元になった明細テーブル。2026-09-27 以降の正は tap_affiliate_order_lines。';

-- -----------------------------------------------------------------------------
-- 2) 月ごとの TAP 取込状況
-- -----------------------------------------------------------------------------
/*
  TAP が全量入るまで紹介者の支払明細を作らせないための状態。

    unfinalized : TAP が全量入っていない。支払明細を作れない
    ready       : 取込は済んだが、人の確認待ち
    finalized   : 確定。支払明細を作ってよい

  過剰な仕組みは持たせない。月と状態と確定者だけを記録する。
*/
create table if not exists public.referral_month_settlements (
  target_month text primary key,
  status text not null default 'unfinalized',
  note text,
  finalized_by uuid references auth.users(id) on delete set null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_month_settlements_month_check
    check (target_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint referral_month_settlements_status_check
    check (status in ('unfinalized', 'ready', 'finalized'))
);

comment on table public.referral_month_settlements is
  '紹介者報酬の月別確定状況。finalized の月だけが紹介者への支払対象になる。';

alter table public.referral_month_settlements enable row level security;

drop policy if exists referral_month_settlements_admin_all on public.referral_month_settlements;
create policy referral_month_settlements_admin_all
  on public.referral_month_settlements
  for all
  using (public.is_app_admin())
  with check (public.is_app_admin());

/*
  既知の月を unfinalized で用意する。
  行が無い月も未確定として扱うので、無くても支払はできない。
*/
insert into public.referral_month_settlements (target_month, status, note)
select m, 'unfinalized', 'TAP全量未投入のため未確定'
  from (values
    ('2026-01'), ('2026-02'), ('2026-03'), ('2026-04'),
    ('2026-05'), ('2026-06'), ('2026-07'), ('2026-08')
  ) as t(m)
on conflict (target_month) do nothing;

-- -----------------------------------------------------------------------------
-- 3) 支払ロック：確定していない月は claim させない
-- -----------------------------------------------------------------------------
/*
  締め月までのどこかに未確定の月があれば、紹介者の支払明細を作らせない。
  金額の根拠が揃っていない状態で振込してしまうのを構造的に止める。
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
      select distinct i.target_month as m
        from public.referral_reward_items i
        left join public.referral_month_settlements s
          on s.target_month = i.target_month
       where i.target_month >= p_start_month
         and i.target_month <= p_cutoff_month
         and coalesce(s.status, 'unfinalized') <> 'finalized'
    ) pending;

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
  '締め月までの紹介者報酬がすべて確定済みか検査する。未確定があれば例外。';

-- -----------------------------------------------------------------------------
-- 4) 旧 affiliate 由来の未払明細を取り除く
-- -----------------------------------------------------------------------------
/*
  affiliate 由来の紹介報酬を、TAP 由来へ置き換えるための片付け。

  ■ 生成はこの関数の役目ではない
  TAP からの生成は既存の同期処理（syncReferralRewardsForMonth）が行う。
  SQL 側で計算式を持つと、アプリ側の計算と二重管理になり必ず食い違う。
  ここは「使われていない旧データを安全に外す」ことだけを担当する。

  ■ 1件でも使用済みなら全体を中止する
  支払済 / claim済 / payout済 が混ざっている状態で消すと、
  支払明細のスナップショットと実データが合わなくなる。
*/
create or replace function public.purge_affiliate_sourced_referral_rewards(
  p_dry_run boolean default true
) returns table (
  deleted_count integer,
  deleted_amount numeric,
  dry_run boolean
)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_used integer;
  v_count integer;
  v_amount numeric;
begin
  if not public.is_app_admin() then
    raise exception 'この操作は親管理者のみ実行できます' using errcode = '42501';
  end if;

  -- 使用済みが1件でもあれば全体を中止
  select count(*) into v_used
    from public.referral_reward_items
   where source_table = 'affiliate_order_lines'
     and (is_paid = true or payment_batch_id is not null or payout_id is not null or paid_at is not null);

  if v_used > 0 then
    raise exception
      'affiliate由来の紹介報酬に使用済み（支払済 / 支払明細に占有 / payout済）が % 件あります。置き換えを中止しました',
      v_used using errcode = '23514';
  end if;

  select count(*), coalesce(sum(coalesce(adjusted_reward_amount, reward_amount, 0)), 0)
    into v_count, v_amount
    from public.referral_reward_items
   where source_table = 'affiliate_order_lines';

  if not p_dry_run then
    delete from public.referral_reward_items
     where source_table = 'affiliate_order_lines'
       and is_paid = false
       and payment_batch_id is null
       and payout_id is null
       and paid_at is null;
  end if;

  return query select v_count, v_amount, p_dry_run;
end;
$fn$;

revoke all on function public.purge_affiliate_sourced_referral_rewards(boolean) from public, anon;
grant execute on function public.purge_affiliate_sourced_referral_rewards(boolean) to authenticated;

comment on function public.purge_affiliate_sourced_referral_rewards(boolean) is
  'affiliate由来の未払紹介報酬を取り除く。使用済みが1件でもあれば中止。既定は dry-run。';
