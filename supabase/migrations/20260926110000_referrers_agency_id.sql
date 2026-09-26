/*
  紹介者を代理店へ帰属させる。

  ■ 支払先は代理店に一本化する
  紹介者は独立した支払先ではない。代理店報酬と、その代理店に帰属する
  紹介者報酬を合算して代理店へ1回だけ支払う。
  そのため紹介者から代理店への参照を1本持たせる。

  ■ 1 referrer → 1 agency / 1 agency → 複数 referrer
  単値の列にすることで前者は構造的に保証される。後者は制約を置かない
  （VALO に 堤理加・堤里香 の2名が帰属するなど実例がある）。

  ■ 紹介報酬の計算は変更しない
  referral_rate / 生涯上限 / 期間判定 / referrer_id はそのまま。
  変わるのは「誰へ支払うか」の解決だけ。

  ■ on delete set null
  既存の creators_agency_id_fkey と同じ規約に揃える。代理店が消えても
  紹介者レコードは残し、支払先未定（hold）として扱う。
*/

alter table public.referrers
  add column if not exists agency_id uuid references public.agencies(id) on delete set null;

comment on column public.referrers.agency_id is
  '帰属する代理店。支払はこの代理店へ合算される。NULL は支払先未定（hold）。';

create index if not exists referrers_agency_id_idx
  on public.referrers(agency_id);

/*
  銀行口座の列を authenticated から隠す。

  RLS は行単位で、列単位の制御はできない。referrers の RLS は管理者限定だが、
  管理者としてログインしたセッションからは口座番号まで読めてしまう。
  agencies で採った列単位 grant と同じ方針に揃える。

  口座の読み書きは全て service role 経由（getSupabaseAdmin /
  createServiceRoleClient）で行われており、列 grant の対象外なので
  既存の管理者処理・紹介者登録は壊れない。
*/
revoke select, update on public.referrers from authenticated;

grant select (
  id, user_id, name, referrer_name, email, phone, line_id, memo,
  referral_code, is_active, is_in_house, agency_id, created_at, updated_at
) on public.referrers to authenticated;

grant update (
  user_id, name, referrer_name, email, phone, line_id, memo,
  referral_code, is_active, is_in_house, agency_id, updated_at
) on public.referrers to authenticated;
