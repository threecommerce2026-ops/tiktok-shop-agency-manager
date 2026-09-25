import { PayeeBankForm } from "@/components/payments/PayeeBankForm";
import { fetchPayeeBankAccounts } from "@/lib/db/payment-queries";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { PAYEE_KIND_LABEL, type PayeeKind } from "@/lib/payments/payable";

/*
  支払先の振込先口座セクション（代理店管理 / 紹介者管理に差し込む）。

  ■ サービスロールで読む理由
  agencies の銀行列は authenticated から列単位で外してあり、
  referrers は RLS が管理者のみ。
  呼び出し元のページで管理者判定を済ませていることが前提。

  ■ 画面へ渡すのはマスク済みの形だけ
  fetchPayeeBankAccounts() が toBankAccountView() を通すので、
  口座番号の全文はこのコンポーネントにも props にも存在しない。
*/
export async function PayeeBankSection({ payeeKind }: { payeeKind: PayeeKind }) {
  const result = await fetchPayeeBankAccounts(getSupabaseAdmin(), payeeKind);

  if (result.error) {
    return (
      <section className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        振込先を読み込めませんでした: {result.error}
      </section>
    );
  }

  // 自社は外部への振込対象ではないので登録を促さない
  const rows = result.data.filter((row) => !row.isInHouse);
  const missing = rows.filter((row) => row.bank.state !== "registered").length;

  return (
    <section className="space-y-4 rounded-2xl border border-white/[0.07] bg-surface-1/40 p-5">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">振込先口座</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-500">
          支払管理で{PAYEE_KIND_LABEL[payeeKind]}へ振り込むための口座です。
          銀行コードと支店コードは振込CSVの出力に必要で、未登録だと支払明細を作成できません。
          口座番号は保存後、画面には下4桁だけを表示します。
        </p>
        {missing > 0 ? (
          <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
            振込先が未登録 / 不備の{PAYEE_KIND_LABEL[payeeKind]}が {missing} 件あります。
            登録するまで支払管理では「振込保留」として扱われます。
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {PAYEE_KIND_LABEL[payeeKind]}が登録されていません。
          </p>
        ) : (
          rows.map((row) => (
            <div
              key={row.payeeId}
              className="rounded-xl border border-white/[0.06] bg-surface-1/60 p-4"
            >
              <p className="text-sm font-medium text-zinc-100">{row.payeeName}</p>
              <div className="mt-2">
                <PayeeBankForm
                  payeeKind={row.payeeKind}
                  payeeId={row.payeeId}
                  payeeName={row.payeeName}
                  bank={row.bank}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
