"use client";

import { useState, useTransition } from "react";

import {
  importTapAffiliateOrdersAction,
  type TapImportPreview,
} from "@/app/actions/import-tap-affiliate-orders";
import { TAP_EXCLUSION_LABEL } from "@/lib/referrals/tap-referral-source";

/*
  TAP注文明細の取込画面。

  ■ 必ず「プレビュー → 確認 → 確定取込」の順にする
  ここで取り込んだ明細がそのまま紹介者報酬の計算元になる。
  ファイルを選んだ瞬間に取り込むと、中身を見ないまま
  支払の根拠が変わってしまう。

  ■ 画面の制御だけに頼らない
  未登録クリエイターがいるとき、プレビューと違うファイルを送ったときは、
  server action 側でも拒否する。ここでボタンを無効にするのは
  「押せないこと」を分かりやすくするためで、防御そのものではない。
*/

type ImportResult = {
  ok: boolean;
  message: string;
  parsedCount?: number;
  insertedOrUpdatedCount?: number;
  creatorCount?: number;
  duplicateFile?: boolean;
  unknownCreatorCount?: number;
  skippedUnlinkedRowCount?: number;
  aliasedRowCount?: number;
  preview?: TapImportPreview;
};

const yen = (value: number) =>
  "¥" + Math.round(value).toLocaleString("ja-JP");
const int = (value: number) => value.toLocaleString("ja-JP");

const card =
  "rounded-xl border border-white/[0.08] bg-surface-1/50 p-4 text-sm text-zinc-200";
const th =
  "whitespace-nowrap border-b border-zinc-800 bg-surface-1/80 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const td = "whitespace-nowrap px-3 py-2 text-xs";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface-1/40 px-3 py-2">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-1 font-mono text-sm text-zinc-100">{value}</p>
    </div>
  );
}

export function TapOrdersImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<TapImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [isPending, startTransition] = useTransition();

  /*
    プレビュー済みのファイルのハッシュ。
    確定時にこれを一緒に送り、server 側で今のファイルと突き合わせる。
  */
  const previewedHash = preview?.fileHash ?? null;
  const unknownCount = preview?.unknownCreators.length ?? 0;
  const canConfirm = Boolean(preview) && unknownCount === 0 && !isPending;

  const chooseFile = (next: File | null) => {
    setFile(next);
    // ファイルを変えたらプレビューを捨てる。古い確認結果で確定させない
    setPreview(null);
    setResult(null);
  };

  const run = (dryRun: boolean) => {
    if (!file) {
      setResult({ ok: false, message: "TAP Excelファイルを選択してください。" });
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    if (dryRun) formData.append("dry_run", "1");
    else if (previewedHash) formData.append("preview_file_hash", previewedHash);

    setResult(null);

    startTransition(async () => {
      const response = await importTapAffiliateOrdersAction(formData);
      setResult(response);
      if (dryRun && response.preview) setPreview(response.preview);
      // 取り込み後は続けて押せないようにプレビューを閉じる
      if (!dryRun && response.ok) setPreview(null);
    });
  };

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          親管理画面
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
          TAP注文明細の取込
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-500">
          ここで取り込んだ明細が
          <span className="font-semibold text-zinc-300">紹介者報酬の計算元</span>
          になります。必ずプレビューで内容を確認してから取り込んでください。
        </p>
      </div>

      {/* ---------------- ファイル選択 ---------------- */}
      <section className={card}>
        <label className="text-[11px] font-medium text-zinc-400" htmlFor="tap-file">
          TAP Excel（.xlsx）
        </label>
        <input
          id="tap-file"
          type="file"
          accept=".xlsx,.xls"
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          className="mt-2 block w-full text-xs text-zinc-300 file:mr-3 file:min-h-[36px] file:rounded-lg file:border file:border-white/[0.12] file:bg-surface-1 file:px-3 file:text-xs file:text-zinc-200"
        />
        {file ? (
          <p className="mt-2 font-mono text-[11px] text-zinc-500">
            {file.name}（{int(Math.round(file.size / 1024))} KB）
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => run(true)}
            disabled={!file || isPending}
            className="min-h-[40px] rounded-lg bg-[var(--accent-cyan)] px-4 text-sm font-semibold text-black disabled:opacity-50"
          >
            {isPending && !preview ? "確認中…" : "プレビュー"}
          </button>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={!canConfirm}
            className="min-h-[40px] rounded-lg border border-white/[0.12] px-4 text-sm font-medium text-zinc-100 hover:bg-white/[0.06] disabled:opacity-40"
          >
            {isPending && preview ? "取込中…" : "確定取込"}
          </button>
          {!preview ? (
            <span className="text-[11px] text-zinc-500">
              先にプレビューで内容を確認してください。
            </span>
          ) : null}
        </div>
      </section>

      {/* ---------------- 結果メッセージ ---------------- */}
      {result ? (
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
            result.ok
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/25 bg-red-500/10 text-red-200"
          }`}
        >
          {result.message}
        </p>
      ) : null}

      {/* ---------------- 取込結果 ---------------- */}
      {result?.ok && result.insertedOrUpdatedCount != null ? (
        <section className={card}>
          <h2 className="text-sm font-semibold text-zinc-200">取込結果</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="総行数" value={int(result.parsedCount ?? 0)} />
            <Stat
              label="新規 + 更新"
              value={int(result.insertedOrUpdatedCount)}
            />
            <Stat
              label="スキップ（未紐付け）"
              value={int(result.skippedUnlinkedRowCount ?? 0)}
            />
            <Stat label="別名で寄せた行" value={int(result.aliasedRowCount ?? 0)} />
          </div>
          <p className="mt-3 text-[11px] text-zinc-500">
            未登録クリエイター {int(result.unknownCreatorCount ?? 0)} 名
            {result.preview?.periodStart
              ? ` ／ 対象期間 ${result.preview.periodStart} 〜 ${result.preview.periodEnd}`
              : ""}
          </p>
        </section>
      ) : null}

      {/* ---------------- プレビュー ---------------- */}
      {preview ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-100">
            <p className="font-semibold">
              これはプレビューです。まだデータベースには保存されていません。
            </p>
            <p className="mt-1 text-[11px] leading-relaxed">
              内容を確認し、問題なければ「確定取込」を押してください。
              ファイルを選び直すとプレビューは無効になります。
            </p>
          </div>

          <section className={card}>
            <h2 className="text-sm font-semibold text-zinc-200">ファイル</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="ファイル名" value={preview.fileName} />
              <Stat label="ファイルhash" value={preview.fileHash.slice(0, 16) + "…"} />
              <Stat label="総行数" value={int(preview.totalRows)} />
              <Stat
                label="対象期間"
                value={
                  preview.periodStart
                    ? `${preview.periodStart} 〜 ${preview.periodEnd}`
                    : "—"
                }
              />
            </div>
          </section>

          <section className={card}>
            <h2 className="text-sm font-semibold text-zinc-200">取込の内訳</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="新規候補" value={int(preview.newRowCount)} />
              <Stat label="更新候補" value={int(preview.existingRowCount)} />
              <Stat
                label="スキップ（未紐付け）"
                value={int(preview.totalRows - preview.newRowCount - preview.existingRowCount)}
              />
              <Stat
                label="成果報酬ベース総額"
                value={yen(preview.commissionBaseTotal)}
              />
              <Stat label="クリエイター数" value={int(preview.creatorCount)} />
              <Stat label="既知クリエイター" value={int(preview.knownCreatorCount)} />
              <Stat label="別名で寄せた行" value={int(preview.aliasedRowCount)} />
              <Stat label="未登録クリエイター" value={int(unknownCount)} />
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-zinc-200">月別</h2>
            <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
              <table className="min-w-[520px] w-full border-collapse">
                <thead>
                  <tr>
                    <th className={th}>対象月</th>
                    <th className={th}>行数</th>
                    <th className={th}>成果報酬ベース</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.monthCounts.map((m) => (
                    <tr key={m.month} className="border-b border-zinc-800/70">
                      <td className={`${td} font-mono text-zinc-100`}>{m.month}</td>
                      <td className={`${td} text-right text-zinc-300`}>
                        {int(m.rowCount)}
                      </td>
                      <td className={`${td} text-right text-zinc-300`}>
                        {yen(m.commissionBase)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {preview.excludedCounts.length > 0 ? (
            <section className={card}>
              <h2 className="text-sm font-semibold text-zinc-200">
                紹介者報酬の対象外になる行
              </h2>
              <ul className="mt-2 space-y-1 text-xs text-zinc-400">
                {preview.excludedCounts.map((e) => (
                  <li key={e.reason}>
                    {TAP_EXCLUSION_LABEL[
                      e.reason as keyof typeof TAP_EXCLUSION_LABEL
                    ] ?? e.reason}
                    ：{int(e.rowCount)} 行
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-zinc-600">
                これらの行も明細としては取り込まれます。紹介者報酬の計算だけ対象外になります。
              </p>
            </section>
          ) : null}

          {preview.appliedAliases.length > 0 ? (
            <section className={card}>
              <h2 className="text-sm font-semibold text-zinc-200">
                適用した別名（改名）
              </h2>
              <ul className="mt-2 space-y-1 font-mono text-xs text-zinc-300">
                {preview.appliedAliases.map((a) => (
                  <li key={`${a.from}-${a.to}`}>
                    {a.from} → {a.to}（{int(a.rowCount)} 行）
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {unknownCount > 0 ? (
            <section className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/[0.08] p-4">
              <h2 className="text-sm font-semibold text-red-100">
                未登録クリエイターがあります（{int(unknownCount)} 名）
              </h2>
              <p className="text-[11px] leading-relaxed text-red-100">
                先にクリエイター登録または別名設定を行ってください。
                一部のクリエイターが抜けたまま取り込むと、その月を
                「全部入った」として扱えなくなります。
                <span className="font-semibold">
                  解消するまで確定取込はできません。
                </span>
              </p>
              <div className="overflow-x-auto rounded-lg border border-red-400/20 bg-zinc-950/40">
                <table className="min-w-[560px] w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={th}>TikTok ID</th>
                      <th className={th}>行数</th>
                      <th className={th}>成果報酬ベース</th>
                      <th className={th}>対象月</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.unknownCreators.map((c) => (
                      <tr key={c.tiktokId} className="border-b border-zinc-800/70">
                        <td className={`${td} font-mono text-zinc-100`}>
                          {c.tiktokId}
                        </td>
                        <td className={`${td} text-right text-zinc-300`}>
                          {int(c.rowCount)}
                        </td>
                        <td className={`${td} text-right text-zinc-300`}>
                          {yen(c.commissionBase)}
                        </td>
                        <td className={`${td} text-zinc-400`}>
                          {c.months.join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
