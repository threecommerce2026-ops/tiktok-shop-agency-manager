import type { ReactNode } from "react";

export default function ReferrerAreaLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-full bg-surface-0">{children}</div>;
}
