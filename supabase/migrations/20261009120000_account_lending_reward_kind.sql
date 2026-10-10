-- =============================================================================
-- 端末貸し出し（アカウント貸出）報酬を代理店報酬と区別して記録する
-- =============================================================================
/*
  ■ 何のための変更か
  区分 account_management_type = 'account_lending' のクリエイターは、
  TikTok 側で AK（agency_split_rate）= 100% になっており、
  AP（agency_revenue）の全額がいったん自社へ入っている。

  この AP に分配率を掛けたものを貸し出し先へ支払う。

      貸し出し先 = AP × 分配率（既定 80%）
      自社       = AP − 貸し出し先

  計算元（AP）・対象注文判定・丸め・月次集計・支払経路は
  通常の代理店報酬とまったく同じものを使う。
  新しい報酬テーブルや新しい支払経路は作らない。
  payment_batches.payee_kind も 'agency' のまま使うため、
  支払系の制約・RPC には一切手を入れない。

  ■ この migration が足すもの
  ① agency_reward_items.reward_kind
     通常の代理店報酬か端末貸し出し報酬かの区別。
     既定 'agency' なので既存 2,124 行は通常の代理店報酬として扱われる。

  ② agency_reward_items.lending_split_rate
     その明細に実際に適用した分配率。
     既定値を後から変えても、過去の支払根拠が明細から辿れるようにする。

  ③ creator_monthly_agency_assignments.lending_split_rate
     クリエイターごと・月ごとの分配率の個別設定。
     未設定（null）なら ACCOUNT_LENDING_SPLIT_RATE（80%）を使う。

     分配先そのものは、このテーブルの既存列 agency_id
     （対象月の所属代理店）をそのまま使う。貸し出し先は
     is_in_house = false の代理店として agencies に登録する。
     分配先用のマスタを別に作らない。

  ■ DML は 0 件
  既存データは1行も書き換えない。
  3列すべて「追加」だけで、既存列・既存制約・RLS・ポリシー・関数・
  トリガには触らない。

  ■ 権限
  agency_reward_items と creator_monthly_agency_assignments は
  テーブルレベルで authenticated に GRANT されているため
  （referrers のような列レベル GRANT ではない）、
  列を足すだけで読み書きできる。追加の GRANT は不要。
  適用後に実測で確認すること。

  ■ 適用順序の注意
  アプリ側（エンジン・sync）がこの3列を書き込むため、
  この migration はアプリのデプロイと同時か、それより前に適用する。

  逆に、貸し出しクリエイターの月別所属を貸し出し先へ変更するのは
  必ずアプリのデプロイ後にすること。
  エンジン変更前に所属だけ変えると、既存のエンジンが
  「外部代理店」と判定して AP の 100% を支払対象にしてしまう。
*/

-- ① 報酬の種類 -----------------------------------------------------------------
alter table public.agency_reward_items
  add column if not exists reward_kind text not null default 'agency';

comment on column public.agency_reward_items.reward_kind is
  'agency=通常の代理店報酬（AP を100%） / account_lending=端末貸し出し報酬（AP × lending_split_rate）。紹介者報酬5%は referral_reward_items 側の別制度。';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agency_reward_items'::regclass
       and conname = 'agency_reward_items_reward_kind_check'
  ) then
    alter table public.agency_reward_items
      add constraint agency_reward_items_reward_kind_check
      check (reward_kind in ('agency', 'account_lending'));
  end if;
end $$;

-- ② 明細に適用した分配率 -------------------------------------------------------
alter table public.agency_reward_items
  add column if not exists lending_split_rate numeric;

comment on column public.agency_reward_items.lending_split_rate is
  '端末貸し出し報酬で実際に適用した分配率（0 < rate <= 1）。通常の代理店報酬では null。既定値を後から変えても過去の支払根拠が辿れるように明細へ残す。';

do $$
begin
  /*
    分配率の範囲。
    「80」のような % 表記が入ると支払額が 100 倍になるため、
    0 < rate <= 1 以外は保存させない。
  */
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agency_reward_items'::regclass
       and conname = 'agency_reward_items_lending_split_rate_range_check'
  ) then
    alter table public.agency_reward_items
      add constraint agency_reward_items_lending_split_rate_range_check
      check (lending_split_rate is null
             or (lending_split_rate > 0 and lending_split_rate <= 1));
  end if;

  /*
    種類と分配率の整合。
      account_lending … 分配率を必ず残す（支払根拠になるため）
      agency          … 分配率を持たない（通常報酬に率は無い）
  */
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agency_reward_items'::regclass
       and conname = 'agency_reward_items_lending_split_rate_kind_check'
  ) then
    alter table public.agency_reward_items
      add constraint agency_reward_items_lending_split_rate_kind_check
      check (
        (reward_kind = 'account_lending' and lending_split_rate is not null)
        or (reward_kind <> 'account_lending' and lending_split_rate is null)
      );
  end if;
end $$;

/* 端末貸し出しの明細だけを引く索引（件数が少ないため部分索引） */
create index if not exists agency_reward_items_account_lending_idx
  on public.agency_reward_items (target_month, agency_id)
  where reward_kind = 'account_lending';

-- ③ クリエイターごと・月ごとの分配率の個別設定 ---------------------------------
/*
  テーブルが無い環境（ローカル・CI の最小構成）では飛ばす。
  本番には 157 行ある（2026-01〜2026-08 / 44 クリエイター）。
  C-6 と同じく、環境差で migration 全体を落とさない。
*/
do $$
begin
  if not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'creator_monthly_agency_assignments'
      and c.relkind = 'r'
  ) then
    raise notice 'creator_monthly_agency_assignments が無いため分配率の列追加を飛ばします';
    return;
  end if;

  alter table public.creator_monthly_agency_assignments
    add column if not exists lending_split_rate numeric;

  comment on column public.creator_monthly_agency_assignments.lending_split_rate is
    '端末貸し出しの分配率の個別設定（0 < rate <= 1）。null なら既定 80%。分配先は同じ行の agency_id（対象月の所属代理店）。';

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.creator_monthly_agency_assignments'::regclass
       and conname = 'creator_monthly_agency_assignments_lending_split_rate_check'
  ) then
    alter table public.creator_monthly_agency_assignments
      add constraint creator_monthly_agency_assignments_lending_split_rate_check
      check (lending_split_rate is null
             or (lending_split_rate > 0 and lending_split_rate <= 1));
  end if;
end $$;
