-- =============================================================================
-- Creator monthly account management types
-- クリエイター区分（通常 / 自社運用 / アカウント貸出）の月別確定
-- =============================================================================
/*
  ■ なぜ必要か
  紹介報酬は「その月に発生した THREE の取り分（W+X）の 5%」で、
  発生月ごとに帰属が決まる月次の概念。
  ところが区分は creators.account_management_type の現在値しか無く、
  紹介報酬の計算が全対象月へ現在値を適用していた。

  実例（2026-10-02 監査）: kanya_land は 2026-03〜08 に
  W+X 759,181円（紹介報酬 37,959.05円相当）の実績があり紹介者も居るが、
  2026-09-30 に standard → self_operated へ変更したため、
  過去 6 か月すべてが対象外として扱われていた。

  ■ 正式ルール（2026-10-02 確定）
  区分の変更は過去月へ遡及しない。
    2026-03〜08 standard → その 6 か月は standard
    2026-09     self_operated へ変更 → 09 以降が self_operated

  ■ 月別所属とは別テーブルにする
  所属（どの代理店へ AP を帰属させるか）と
  区分（紹介報酬が発生しうるか）は別概念で、
  片方だけ確定したい場面がある。creator_monthly_agency_assignments
  とは結合しない。

  ■ 根拠が無い過去は埋めない
  変更履歴（creator_master_change_logs）から過去区分を確定できる
  クリエイターだけが補正候補。履歴が無い 11 名
  （self_operated 8 / account_lending 3）は要確認として残す。
  この migration はテーブルと RPC だけを作り、データは入れない。
*/

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 月別区分
-- ---------------------------------------------------------------------------

create table if not exists public.creator_monthly_account_management_types (
  id uuid primary key default gen_random_uuid(),

  creator_id uuid not null
    references public.creators(id)
    on delete cascade,

  target_month text not null
    check (target_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  /*
    区分は lib/creators/account-management-type.ts の
    ACCOUNT_MANAGEMENT_TYPES と同じ 3 値。
    所属と違い NULL は許さない（「区分が無い月」は
    行が存在しないことで表す。未確定と「区分なし」を混同させない）。
  */
  account_management_type text not null
    check (account_management_type in ('standard', 'self_operated', 'account_lending')),

  updated_by uuid null
    references auth.users(id),

  updated_by_email text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint creator_monthly_account_management_types_unique
    unique (creator_id, target_month)
);

comment on table public.creator_monthly_account_management_types is
  'クリエイター区分の月別確定。紹介報酬は対象月のこの値で判定する。現在値（creators.account_management_type）を過去月へ遡及させない。';

comment on column public.creator_monthly_account_management_types.account_management_type is
  'standard=通常（紹介報酬5%の対象） / self_operated=自社運用 / account_lending=アカウント貸出';

create index if not exists creator_monthly_account_management_types_month_idx
  on public.creator_monthly_account_management_types (target_month);

create index if not exists creator_monthly_account_management_types_creator_idx
  on public.creator_monthly_account_management_types (creator_id);

alter table public.creator_monthly_account_management_types
enable row level security;

grant select, insert, update, delete
on table public.creator_monthly_account_management_types
to authenticated;

grant all
on table public.creator_monthly_account_management_types
to service_role;

drop policy if exists "Admins can view monthly account management types"
on public.creator_monthly_account_management_types;

create policy "Admins can view monthly account management types"
on public.creator_monthly_account_management_types
for select
to authenticated
using (public.is_app_admin());

drop policy if exists "Admins can insert monthly account management types"
on public.creator_monthly_account_management_types;

create policy "Admins can insert monthly account management types"
on public.creator_monthly_account_management_types
for insert
to authenticated
with check (
  public.is_app_admin()
  and (updated_by is null or updated_by = auth.uid())
);

drop policy if exists "Admins can update monthly account management types"
on public.creator_monthly_account_management_types;

create policy "Admins can update monthly account management types"
on public.creator_monthly_account_management_types
for update
to authenticated
using (public.is_app_admin())
with check (
  public.is_app_admin()
  and (updated_by is null or updated_by = auth.uid())
);

drop policy if exists "Admins can delete monthly account management types"
on public.creator_monthly_account_management_types;

create policy "Admins can delete monthly account management types"
on public.creator_monthly_account_management_types
for delete
to authenticated
using (public.is_app_admin());

-- ---------------------------------------------------------------------------
-- 監査ログ
-- ---------------------------------------------------------------------------
/*
  区分の変更は紹介報酬の金額を動かすので、
  月別所属（creator_monthly_agency_assignment_logs）と同じ粒度で
  「誰が・いつ・どのクリエイターの・何月を・何から何へ」を残す。
  監査ログなので update / delete は誰にも許可しない。
*/

create table if not exists public.creator_monthly_account_management_type_logs (
  id uuid primary key default gen_random_uuid(),

  creator_id uuid not null
    references public.creators(id)
    on delete cascade,

  target_month text not null
    check (target_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  /* 変更前。その月に確定が無かった場合は NULL */
  from_type text null
    check (from_type is null or from_type in ('standard', 'self_operated', 'account_lending')),

  /* 変更後。解除した場合は NULL */
  to_type text null
    check (to_type is null or to_type in ('standard', 'self_operated', 'account_lending')),

  action text not null
    check (action in ('save', 'reset')),

  changed_by uuid not null
    references auth.users(id),

  changed_by_email text null,

  created_at timestamptz not null default now()
);

comment on table public.creator_monthly_account_management_type_logs is
  'クリエイター区分の月別確定の変更履歴。紹介報酬の帰属が変わる操作を残す。';

create index if not exists creator_monthly_account_management_type_logs_creator_idx
  on public.creator_monthly_account_management_type_logs (creator_id, created_at desc);

create index if not exists creator_monthly_account_management_type_logs_month_idx
  on public.creator_monthly_account_management_type_logs (target_month, created_at desc);

alter table public.creator_monthly_account_management_type_logs
enable row level security;

grant select, insert
on table public.creator_monthly_account_management_type_logs
to authenticated;

grant all
on table public.creator_monthly_account_management_type_logs
to service_role;

drop policy if exists "Admins can view monthly account management type logs"
on public.creator_monthly_account_management_type_logs;

create policy "Admins can view monthly account management type logs"
on public.creator_monthly_account_management_type_logs
for select
to authenticated
using (public.is_app_admin());

drop policy if exists "Admins can insert monthly account management type logs"
on public.creator_monthly_account_management_type_logs;

create policy "Admins can insert monthly account management type logs"
on public.creator_monthly_account_management_type_logs
for insert
to authenticated
with check (
  public.is_app_admin()
  and changed_by = auth.uid()
);

-- 監査ログなので UPDATE / DELETE は許可しない

-- ---------------------------------------------------------------------------
-- 確定 / 解除 RPC
-- ---------------------------------------------------------------------------
/*
  月別所属の set_creator_monthly_agency_assignment と同じ形にそろえる。
  ・auth.uid() が必要（service_role だけでは実行させない）
  ・管理者のみ
  ・保存と履歴を同じトランザクションで行う

  creators.account_management_type（現在値）はここでは変更しない。
  現在区分の変更はクリエイターマスタ編集が担当する。
*/

create or replace function public.set_creator_monthly_account_management_type(
  p_creator_id uuid,
  p_target_month text,
  p_account_management_type text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid;
  v_user_email text;
  v_old_type text;
  v_found boolean;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'ログインが必要です。';
  end if;

  if not public.is_app_admin() then
    raise exception '管理者権限が必要です。';
  end if;

  if p_target_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '対象月が不正です。';
  end if;

  if not exists (select 1 from public.creators where id = p_creator_id) then
    raise exception 'クリエイターが見つかりません。';
  end if;

  if p_account_management_type is null
     or p_account_management_type not in ('standard', 'self_operated', 'account_lending') then
    raise exception '区分が不正です。';
  end if;

  v_user_email := auth.jwt() ->> 'email';

  select account_management_type
  into v_old_type
  from public.creator_monthly_account_management_types
  where creator_id = p_creator_id
    and target_month = p_target_month
  for update;

  v_found := found;

  /* 同じ値の上書きは履歴を増やさない */
  if v_found and v_old_type = p_account_management_type then
    return;
  end if;

  insert into public.creator_monthly_account_management_types (
    creator_id,
    target_month,
    account_management_type,
    updated_by,
    updated_by_email,
    created_at,
    updated_at
  )
  values (
    p_creator_id,
    p_target_month,
    p_account_management_type,
    v_user_id,
    v_user_email,
    now(),
    now()
  )
  on conflict (creator_id, target_month)
  do update set
    account_management_type = excluded.account_management_type,
    updated_by = excluded.updated_by,
    updated_by_email = excluded.updated_by_email,
    updated_at = now();

  insert into public.creator_monthly_account_management_type_logs (
    creator_id,
    target_month,
    from_type,
    to_type,
    action,
    changed_by,
    changed_by_email
  )
  values (
    p_creator_id,
    p_target_month,
    v_old_type,
    p_account_management_type,
    'save',
    v_user_id,
    v_user_email
  );
end;
$$;

create or replace function public.reset_creator_monthly_account_management_type(
  p_creator_id uuid,
  p_target_month text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid;
  v_user_email text;
  v_old_type text;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'ログインが必要です。';
  end if;

  if not public.is_app_admin() then
    raise exception '管理者権限が必要です。';
  end if;

  if p_target_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '対象月が不正です。';
  end if;

  v_user_email := auth.jwt() ->> 'email';

  select account_management_type
  into v_old_type
  from public.creator_monthly_account_management_types
  where creator_id = p_creator_id
    and target_month = p_target_month
  for update;

  if not found then
    return;
  end if;

  delete from public.creator_monthly_account_management_types
  where creator_id = p_creator_id
    and target_month = p_target_month;

  insert into public.creator_monthly_account_management_type_logs (
    creator_id,
    target_month,
    from_type,
    to_type,
    action,
    changed_by,
    changed_by_email
  )
  values (
    p_creator_id,
    p_target_month,
    v_old_type,
    null,
    'reset',
    v_user_id,
    v_user_email
  );
end;
$$;

revoke all
on function public.set_creator_monthly_account_management_type(uuid, text, text)
from public;

revoke all
on function public.reset_creator_monthly_account_management_type(uuid, text)
from public;

grant execute
on function public.set_creator_monthly_account_management_type(uuid, text, text)
to authenticated;

grant execute
on function public.reset_creator_monthly_account_management_type(uuid, text)
to authenticated;
