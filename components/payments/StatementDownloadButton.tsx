"use client";

import { useState } from "react";

/*
  支払明細書（PDF / ZIP）のダウンロードボタン。

  ■ 生成に時間がかかるので状態を出す
  代理店ぶんのPDFをその場で作るため、押してから数秒かかる。
  何も出ないと二度押しされ、同じものを2回作ってしまう。

  ■ 失敗を黙って捨てない
  拒否されたときは経路が理由を返すので、それをそのまま見せる。
  「金額整合性エラー」などは、EMI が調べる手がかりになる。
*/

/** サーバーが返したファイル名を使う。無ければ渡された既定名 */
function fileNameFromResponse(response: Response, fallback: string): string {
  const header = response.headers.get("content-disposition") ?? "";
  // filename*=UTF-8''... を優先（日本語はこちらに入る）
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // 壊れていれば既定名へ落とす
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : fallback;
}

export function StatementDownloadButton({
  href,
  label,
  pendingLabel,
  fallbackFileName,
  successLabel,
  className,
}: {
  href: string;
  label: string;
  pendingLabel: string;
  fallbackFileName: string;
  /** 完了後に出す文言。件数などを入れる */
  successLabel?: string;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<
    { ok: boolean; text: string } | null
  >(null);

  const download = async () => {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(href, { cache: "no-store" });

      if (!response.ok) {
        /*
          経路は JSON でエラーを返す。読めない場合だけ状態コードを出す。
        */
        let text = `ダウンロードできませんでした（${response.status}）。`;
        try {
          const body = await response.json();
          if (typeof body?.error === "string") text = body.error;
        } catch {
          // JSONでなければ既定の文言のまま
        }
        setMessage({ ok: false, text });
        return;
      }

      const blob = await response.blob();
      const fileName = fileNameFromResponse(response, fallbackFileName);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      const count = response.headers.get("x-statement-count");
      const rejected = Number(response.headers.get("x-statement-rejected") ?? "0");
      const base =
        successLabel ??
        (count ? `${count}社分の支払明細を作成しました。` : "支払明細を作成しました。");
      setMessage({
        ok: true,
        text:
          rejected > 0
            ? `${base}（${rejected} 件は出力できませんでした。詳細は支払明細の画面で確認してください）`
            : base,
      });
    } catch {
      setMessage({
        ok: false,
        text: "ダウンロードに失敗しました。通信状況を確認してもう一度お試しください。",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={download}
        disabled={pending}
        className={
          className ??
          "inline-flex min-h-[36px] items-center rounded-lg border border-white/[0.1] px-3 text-xs font-medium text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50"
        }
      >
        {pending ? pendingLabel : label}
      </button>
      {message ? (
        <span
          role="status"
          className={`text-[11px] leading-relaxed ${
            message.ok ? "text-emerald-300" : "text-red-300"
          }`}
        >
          {message.text}
        </span>
      ) : null}
    </span>
  );
}
