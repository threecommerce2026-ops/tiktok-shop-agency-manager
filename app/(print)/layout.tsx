import type { ReactNode } from "react";

import { STATEMENT_PRINT_STYLES } from "@/components/payments/AgencyStatementDocument";

/*
  帳票専用のレイアウト。

  ヘッダー・サイドナビなどのアプリ外装を通さない。印刷したときに
  画面の装飾が紙へ出てしまうのを、CSSで隠すのではなく構造で避ける。

  印刷CSSは帳票側のファイルが持つ（globals.css に依存しない）。
*/
export const dynamic = "force-dynamic";

export default function PrintLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STATEMENT_PRINT_STYLES }} />
      {children}
    </>
  );
}
