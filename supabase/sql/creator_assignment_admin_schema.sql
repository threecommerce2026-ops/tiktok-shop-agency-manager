-- クリエイター振り分け管理（親管理者向け）
-- Supabase SQL Editor で実行

-- 未振り分けを表現するため agency_id を NULL 許可
alter table public.creators
  alter column agency_id drop not null;

comment on column public.creators.agency_id is '所属代理店。NULL は未振り分け';

-- 親管理者は全クリエイターを更新可能
drop policy if exists "creators_update_agency" on public.creators;
create policy "creators_update_admin_or_agency"
  on public.creators for update
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
  );
