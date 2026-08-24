-- =============================================================================
-- 紹介者報酬: 紹介者 × クリエイター別の累計支払い上限（既定 300 万円）
-- 前提: admin_referrals_schema.sql / referrer_portal_schema.sql 実行済み
-- =============================================================================

alter table public.creator_referrals
  add column if not exists lifetime_payout_cap numeric(16, 2) not null default 3000000;

alter table public.creator_referrals
  add column if not exists lifetime_paid_amount numeric(16, 2) not null default 0;

comment on column public.creator_referrals.lifetime_payout_cap is '紹介者×クリエイター別の累計支払い上限（円）';
comment on column public.creator_referrals.lifetime_paid_amount is '紹介者×クリエイター別の支払い済み累計（円）';

alter table public.referral_reward_items
  add column if not exists cap_applied boolean not null default false;

alter table public.referral_reward_items
  add column if not exists cap_reached boolean not null default false;

alter table public.referral_reward_items
  add column if not exists original_reward_amount numeric(16, 2);

alter table public.referral_reward_items
  add column if not exists adjusted_reward_amount numeric(16, 2);

comment on column public.referral_reward_items.cap_applied is '上限適用により報酬額を調整したか';
comment on column public.referral_reward_items.cap_reached is '上限到達により報酬対象外となったか';
comment on column public.referral_reward_items.original_reward_amount is '上限適用前の報酬額';
comment on column public.referral_reward_items.adjusted_reward_amount is '上限適用後の報酬額';

update public.referral_reward_items
set
  original_reward_amount = coalesce(original_reward_amount, reward_amount),
  adjusted_reward_amount = coalesce(adjusted_reward_amount, reward_amount)
where original_reward_amount is null
   or adjusted_reward_amount is null;

update public.creator_referrals cr
set lifetime_paid_amount = coalesce(agg.paid_total, 0)
from (
  select
    rri.creator_id,
    rri.referrer_id,
    sum(coalesce(rri.adjusted_reward_amount, rri.reward_amount, 0)) as paid_total
  from public.referral_reward_items rri
  where rri.is_paid = true
    and rri.is_reward_target = true
  group by rri.creator_id, rri.referrer_id
) agg
where cr.creator_id = agg.creator_id
  and cr.referrer_id = agg.referrer_id;
