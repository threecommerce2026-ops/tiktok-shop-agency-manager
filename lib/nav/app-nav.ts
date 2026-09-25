import type { UserRole } from "@/lib/db/user-context";

/*
  アプリのナビゲーション定義（単一ソース）。

  日常業務で使う画面だけを並べる。
  旧画面はルートとして残すが、ここには載せない（= サイドバー非表示）。
*/

export type NavItem = {
  href: string;
  label: string;
  /** モバイル用の短縮表記 */
  short: string;
  description: string;
  adminOnly?: boolean;
  /** 配下とみなす旧ルート。ハイライト判定に使う */
  aliases?: readonly string[];
};

export const APP_NAV: readonly NavItem[] = [
  {
    href: "/dashboard",
    label: "ダッシュボード",
    short: "DS",
    description: "今月のGMV・代理店収益・紹介報酬の全体状況",
  },
  {
    href: "/creators",
    label: "クリエイター",
    short: "CR",
    description: "クリエイターマスタ。所属代理店・紹介者・区分・分配率の管理",
    aliases: [
      "/admin/creator-master-editor",
      "/admin/creator-assignment",
      "/admin/creator-referrals",
      "/admin/monthly-agency-assignments",
      "/admin/creator-assignment-logs",
      "/admin/creator-commission-rate-logs",
    ],
  },
  {
    href: "/sellers",
    label: "セラー",
    short: "SL",
    description: "セラー一覧・接続状態・GMV・ショップ実績",
    aliases: [
      "/admin/sellers",
      "/admin/shop-performance",
      "/admin/partner-center-import",
      "/admin/seller-import-histories",
    ],
  },
  {
    href: "/revenue",
    label: "売上・報酬",
    short: "RV",
    description: "売上 / 代理店報酬 / 紹介者報酬",
    aliases: ["/sales", "/rewards", "/orders", "/admin/referral-payouts"],
  },
  {
    href: "/data-sync",
    label: "データ連携",
    short: "DT",
    description: "TikTok API・CSV取込・同期履歴",
    adminOnly: true,
    aliases: [
      "/admin/affiliate-orders-import",
      "/admin/api-connections",
      "/admin/api-sync",
      "/sales-upload",
      "/csv-logs",
      "/sync-jobs",
    ],
  },
  {
    href: "/admin/agencies",
    label: "代理店管理",
    short: "AG",
    description: "代理店一覧・分配率・ランキング",
    adminOnly: true,
    aliases: ["/admin/agencies-ranking"],
  },
  {
    href: "/settings",
    label: "設定",
    short: "ST",
    description: "アカウントと業務ルールの確認",
  },
] as const;

export function navItemsForRole(role: UserRole): NavItem[] {
  return APP_NAV.filter((item) => !item.adminOnly || role === "admin");
}

/** モバイル下部ナビは主要5件に絞る */
export function mobileNavItemsForRole(role: UserRole): NavItem[] {
  return navItemsForRole(role).filter((item) => item.href !== "/settings");
}

export function isNavItemActive(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true;
  if (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`)) {
    return true;
  }
  return (item.aliases ?? []).some(
    (alias) => pathname === alias || pathname.startsWith(`${alias}/`),
  );
}
