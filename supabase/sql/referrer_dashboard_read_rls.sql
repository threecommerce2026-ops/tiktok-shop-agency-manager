-- =============================================================================
-- 紹介者ダッシュボード: creator_referrals / creators の参照 RLS 補強
-- 前提: referrer_portal_schema.sql 実行済み
-- =============================================================================

drop policy if exists "creator_referrals_select_referrer_or_admin" on public.creator_referrals;
create policy "creator_referrals_select_referrer_or_admin"
  on public.creator_referrals for select
  using (
    public.is_app_admin()
    or referrer_id = public.current_referrer_id()
  );

drop policy if exists "creators_select_referrer_linked" on public.creators;
create policy "creators_select_referrer_linked"
  on public.creators for select
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
    or id in (
      select cr.creator_id
      from public.creator_referrals cr
      where cr.referrer_id = public.current_referrer_id()
    )
  );

drop policy if exists "orders_select_referrer_linked" on public.orders;
create policy "orders_select_referrer_linked"
  on public.orders for select
  using (
    public.is_app_admin()
    or agency_id in (
      select agency_id from public.profiles where id = auth.uid() and agency_id is not null
    )
    or creator_id in (
      select cr.creator_id
      from public.creator_referrals cr
      where cr.referrer_id = public.current_referrer_id()
    )
  );
