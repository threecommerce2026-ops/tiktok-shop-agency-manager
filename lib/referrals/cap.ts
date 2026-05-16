export const DEFAULT_REFERRER_LIFETIME_PAYOUT_CAP_YEN = 3_000_000;

export type ReferralRewardCapInput = {
  originalRewardAmount: number;
  lifetimePayoutCap: number;
  lifetimePaidAmount: number;
  eligible: boolean;
};

export type ReferralRewardCapResult = {
  originalRewardAmount: number;
  adjustedRewardAmount: number;
  rewardAmount: number;
  capApplied: boolean;
  capReached: boolean;
  isRewardTarget: boolean;
};

export function pairReferralKey(referrerId: string, creatorId: string): string {
  return `${referrerId}:${creatorId}`;
}

export function resolveRemainingReferralCap(
  lifetimePayoutCap: number,
  lifetimePaidAmount: number,
): number {
  if (!Number.isFinite(lifetimePayoutCap) || !Number.isFinite(lifetimePaidAmount)) {
    return 0;
  }
  return Math.max(lifetimePayoutCap - lifetimePaidAmount, 0);
}

export function applyReferralRewardCap(input: ReferralRewardCapInput): ReferralRewardCapResult {
  const originalRewardAmount = Math.max(0, Math.round(input.originalRewardAmount));
  const lifetimePayoutCap = Math.max(0, Math.round(input.lifetimePayoutCap));
  const lifetimePaidAmount = Math.max(0, Math.round(input.lifetimePaidAmount));

  if (!input.eligible || originalRewardAmount <= 0) {
    return {
      originalRewardAmount,
      adjustedRewardAmount: 0,
      rewardAmount: 0,
      capApplied: false,
      capReached: false,
      isRewardTarget: false,
    };
  }

  const remainingCap = resolveRemainingReferralCap(lifetimePayoutCap, lifetimePaidAmount);
  if (remainingCap <= 0) {
    return {
      originalRewardAmount,
      adjustedRewardAmount: 0,
      rewardAmount: 0,
      capApplied: true,
      capReached: true,
      isRewardTarget: false,
    };
  }

  const adjustedRewardAmount = Math.min(originalRewardAmount, remainingCap);
  const capApplied = adjustedRewardAmount < originalRewardAmount;
  const capReached = capApplied && adjustedRewardAmount === remainingCap;

  return {
    originalRewardAmount,
    adjustedRewardAmount,
    rewardAmount: adjustedRewardAmount,
    capApplied,
    capReached,
    isRewardTarget: adjustedRewardAmount > 0,
  };
}

export function isReferralCapReached(
  lifetimePayoutCap: number,
  lifetimePaidAmount: number,
): boolean {
  return resolveRemainingReferralCap(lifetimePayoutCap, lifetimePaidAmount) <= 0;
}
