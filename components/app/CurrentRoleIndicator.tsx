import type { UserRole } from "@/lib/db/user-context";

type Props = {
  role: UserRole;
  profileRoleRaw?: string | null;
  profileLoadError?: string | null;
};

export function CurrentRoleIndicator({
  role,
  profileRoleRaw,
  profileLoadError,
}: Props) {
  return (
    <div className="border-b border-white/[0.06] bg-surface-0/80 px-4 py-1.5 text-center sm:px-6">
      <p className="text-[10px] text-zinc-500">
        現在の role:{" "}
        <span className="font-mono font-semibold text-zinc-300">{role}</span>
        {profileRoleRaw != null ? (
          <span className="ml-2 text-zinc-600">
            （profiles.role:{" "}
            <span className="font-mono text-zinc-500">{profileRoleRaw}</span>）
          </span>
        ) : null}
        {profileLoadError ? (
          <span className="ml-2 text-amber-400/90">
            profiles 取得エラー: {profileLoadError}
          </span>
        ) : null}
      </p>
    </div>
  );
}
