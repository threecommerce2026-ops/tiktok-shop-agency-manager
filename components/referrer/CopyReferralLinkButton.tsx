"use client";

import { useState } from "react";

export function CopyReferralLinkButton({ referralLink }: { referralLink: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(referralLink);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
      className="inline-flex min-h-[48px] w-full items-center justify-center rounded-xl border border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/10 px-4 py-3 text-sm font-semibold text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/15"
    >
      {copied ? "コピーしました" : "紹介リンクをコピー"}
    </button>
  );
}
