import { randomBytes } from "node:crypto";

const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateReferralCode(length = 8): string {
  const bytes = randomBytes(length);
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += REFERRAL_CODE_ALPHABET[bytes[index]! % REFERRAL_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeReferralCode(value: string): string {
  return value.trim().toUpperCase();
}
