"use client";

import { useState, useTransition } from "react";
import { importTapAffiliateOrdersAction } from "@/app/actions/import-tap-affiliate-orders";

type ImportResult = {
  ok: boolean;
  message: string;
  parsedCount?: number;
  insertedOrUpdatedCount?: number;
  creatorCount?: number;
  duplicateFile?: boolean;
};

export default function TapOrdersImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!file) {
      setResult({
        ok: false,
        message: "TAP Excelファイルを選択してください。",
      });
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    setResult(null);

    startTransition(async () => {
      const response = await importTapAffiliateOrdersAction(formData);
      setResult(response);
    });
  }

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: "40px 24px",
      }}
    >
      <div style={{ marginBottom: 32 }}>
        <div
          style={{
            fontSize: 13,
            opacity: 0.6,
            marginBottom: 8,
          }}
        >
          Partner Center / TAP
        </div>

        <h1
          style={{
            fontSize: 30,
            fontWeight: 700,
            marginBottom: 12,
          }}
        >
          TAP注文インポート
        </h1>

        <p
          style={{
            lineHeight: 1.8,
            opacity: 0.75,
          }}
        >
          Partner CenterからエクスポートしたTAP注文Excelを取り込みます。
          同じファイルを再度取り込んでも重複登録されません。
          また、期間が一部重複する別ファイルの場合も、
          同じ注文明細は追加せず最新内容へ更新します。
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        style={{
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 16,
          padding: 28,
        }}
      >
        <label
          style={{
            display: "block",
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          TAP注文Excel
        </label>

        <input
          type="file"
          accept=".xlsx,.xls"
          disabled={isPending}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setResult(null);
          }}
        />

        {file && (
          <div
            style={{
              marginTop: 12,
              fontSize: 14,
              opacity: 0.75,
            }}
          >
            選択中：{file.name}
          </div>
        )}

        <button
          type="submit"
          disabled={!file || isPending}
          style={{
            marginTop: 24,
            padding: "12px 22px",
            borderRadius: 10,
            border: 0,
            cursor: !file || isPending ? "not-allowed" : "pointer",
            fontWeight: 700,
          }}
        >
          {isPending ? "取り込み中..." : "TAP注文を取り込む"}
        </button>
      </form>

      {result && (
        <section
          style={{
            marginTop: 24,
            padding: 24,
            borderRadius: 16,
            border: `1px solid ${
              result.ok
                ? "rgba(80,200,120,0.45)"
                : "rgba(255,90,90,0.45)"
            }`,
          }}
        >
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              marginBottom: 12,
            }}
          >
            {result.ok ? "取込結果" : "エラー"}
          </div>

          <p style={{ lineHeight: 1.7 }}>{result.message}</p>

          {result.duplicateFile ? (
            <p
              style={{
                marginTop: 12,
                fontWeight: 600,
              }}
            >
              ✓ 重複データは追加されていません。
            </p>
          ) : (
            result.ok && (
              <div
                style={{
                  marginTop: 20,
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 12,
                }}
              >
                <Stat
                  label="解析明細"
                  value={result.parsedCount ?? 0}
                />

                <Stat
                  label="保存・更新"
                  value={result.insertedOrUpdatedCount ?? 0}
                />

                <Stat
                  label="クリエイター"
                  value={result.creatorCount ?? 0}
                />
              </div>
            )
          )}
        </section>
      )}

      <section
        style={{
          marginTop: 32,
          padding: 24,
          borderRadius: 16,
          background: "rgba(255,255,255,0.035)",
        }}
      >
        <h2
          style={{
            fontSize: 18,
            fontWeight: 700,
            marginBottom: 14,
          }}
        >
          自動処理
        </h2>

        <div style={{ lineHeight: 2 }}>
          <div>① TikTok IDでクリエイターを照合</div>
          <div>② 未登録クリエイターは仮登録</div>
          <div>③ TAP注文明細を保存</div>
          <div>④ 重複明細は追加せず最新データへ更新</div>
          <div>⑤ TAP収益を注文単位で保存</div>
          <div>⑥ 紹介者報酬計算に利用</div>
        </div>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        background: "rgba(255,255,255,0.05)",
      }}
    >
      <div
        style={{
          fontSize: 13,
          opacity: 0.6,
          marginBottom: 6,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
        }}
      >
        {value.toLocaleString("ja-JP")}
      </div>
    </div>
  );
}
