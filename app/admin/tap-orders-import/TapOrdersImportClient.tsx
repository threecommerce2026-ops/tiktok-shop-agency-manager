"use client";

import { useState } from "react";

import { listCreatorAliasesAction } from "@/app/actions/import-affiliate-orders";
import {
  failTapAffiliateOrderImportAction,
  fetchTapCreatorDigestAction,
  fetchTapExistingKeysAction,
  finishTapAffiliateOrderImportAction,
  importTapAffiliateOrderChunkAction,
  startTapAffiliateOrderImportAction,
} from "@/app/actions/import-tap-affiliate-orders";
import {
  buildPayloadChunks,
  MAX_CHUNK_PAYLOAD_BYTES,
  MAX_CHUNK_ROWS,
} from "@/lib/orders/affiliate-order-import-payload";
import { buildCreatorAliasMap, creatorAliasFromRow } from "@/lib/orders/creator-alias";
import {
  getTapFileHash,
  parseTapAffiliateOrderExport,
  type TapAffiliateOrderRow,
} from "@/lib/orders/parse-tap-affiliate-order-export";
import { applyCreatorAliasesToTapRows } from "@/lib/orders/tap-creator-alias";
import {
  buildTapImportPreview,
  type TapImportPreview,
} from "@/lib/orders/tap-import-preview";
import { TAP_EXCLUSION_LABEL } from "@/lib/referrals/tap-referral-source";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";

/*
  TAP注文明細の取込画面。

  ■ Excel 本体をサーバーへ送らない
  Server Action は既定で 1MB までしか受け取らない。以前は File を
  そのまま送っていたため、本番の 4.15MB が 400 で弾かれていた。
  ここではブラウザで Excel を解析し、正規化した行だけを
  400KB / 300行 ずつに分けて送る。既存の affiliate 取込と同じ方式。

  ■ プレビュー → 確認 → 確定取込
  プレビューの時点では DB へ一切書き込まない。
  サーバーへ聞くのは「creators に居るか」「既に入っている行はどれか」だけで、
  どちらもページ単位で取り寄せて手元で突き合わせる（URL を長くしない）。

  ■ 画面の制御だけに頼らない
  未登録クリエイターがいるとき、送信サイズや行数が多すぎるときは、
  サーバー側でも拒否する。ここでボタンを無効にするのは分かりやすさのため。
*/

const yen = (value: number) => "¥" + Math.round(value).toLocaleString("ja-JP");
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

type Message = { ok: boolean; text: string } | null;

type ImportSummary = {
  insertedCount: number;
  skippedCount: number;
  chunkCount: number;
  aliasedRowCount: number;
  periodStart: string | null;
  periodEnd: string | null;
};

export function TapOrdersImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<TapImportPreview | null>(null);
  const [rows, setRows] = useState<TapAffiliateOrderRow[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [progress, setProgress] = useState("");

  const unknownCount = preview?.unknownCreators.length ?? 0;
  const canConfirm = Boolean(preview) && unknownCount === 0 && busy === null;

  const chooseFile = (next: File | null) => {
    setFile(next);
    // ファイルを変えたらプレビューを捨てる。古い確認結果で確定させない
    setPreview(null);
    setRows([]);
    setMessage(null);
    setSummary(null);
    setProgress("");
  };

  // ---------------------------------------------------------------------------
  // プレビュー（DB WRITE なし）
  // ---------------------------------------------------------------------------
  const runPreview = async () => {
    if (!file) {
      setMessage({ ok: false, text: "TAP Excelファイルを選択してください。" });
      return;
    }

    setBusy("preview");
    setMessage(null);
    setSummary(null);
    setProgress("Excelを読み込んでいます…");

    try {
      const bytes = await file.arrayBuffer();
      const fileHash = await getTapFileHash(bytes);
      const parsed = parseTapAffiliateOrderExport(bytes);

      if (parsed.length === 0) {
        setMessage({ ok: false, text: "TAP注文明細をExcelから取得できませんでした。" });
        return;
      }

      // ---- 別名（改名）を先に適用してから一意キーを作り直す --------------------
      setProgress("別名を確認しています…");
      const aliasResult = await listCreatorAliasesAction();
      if (!aliasResult.ok) {
        setMessage({ ok: false, text: aliasResult.error });
        return;
      }
      const aliasMap = buildCreatorAliasMap(
        aliasResult.aliases.map((alias) => creatorAliasFromRow(alias)),
      );
      const applied = applyCreatorAliasesToTapRows(parsed, aliasMap);

      // ---- creators をページ単位で取り寄せて突き合わせる ----------------------
      setProgress("クリエイターを照合しています…");
      const known = new Set<string>();
      for (let page = 0; page < 200; page += 1) {
        const result = await fetchTapCreatorDigestAction({ page });
        if (!result.ok) {
          setMessage({ ok: false, text: result.error });
          return;
        }
        for (const creator of result.creators) {
          if (creator.tiktokId) known.add(creator.tiktokId);
        }
        if (!result.hasMore) break;
      }

      // ---- 既に入っている行を月単位で取り寄せる ------------------------------
      setProgress("既存データを照合しています…");
      const months = [
        ...new Set(applied.rows.map((row) => row.targetMonth).filter(Boolean)),
      ] as string[];
      const existingKeys = new Set<string>();
      for (let page = 0; page < 500; page += 1) {
        const result = await fetchTapExistingKeysAction({ months, page });
        if (!result.ok) {
          setMessage({ ok: false, text: result.error });
          return;
        }
        for (const key of result.keys) existingKeys.add(key);
        if (!result.hasMore) break;
      }

      // ---- 送信の分割（既存 affiliate 取込と同じ上限） ------------------------
      const linked = applied.rows.filter((row) =>
        known.has(normalizeTiktokId(row.creatorTikTokId ?? "")),
      );
      const { chunks, maxChunkBytes } = buildPayloadChunks(linked);

      setPreview(
        buildTapImportPreview({
          fileName: file.name,
          fileHash,
          rows: applied.rows,
          knownTiktokIds: known,
          existingSourceRowKeys: existingKeys,
          aliasedRowCount: applied.aliasedRowCount,
          appliedAliases: applied.appliedAliases,
          chunkCount: chunks.length,
          maxChunkBytes,
        }),
      );
      setRows(applied.rows);
      setProgress("");
      setMessage({
        ok: true,
        text: `${int(parsed.length)} 行を確認しました。まだ取り込んでいません。`,
      });
    } catch (error) {
      setMessage({
        ok: false,
        text: `Excelの読み込みに失敗しました: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      setBusy(null);
      setProgress("");
    }
  };

  // ---------------------------------------------------------------------------
  // 確定取込（分割送信）
  // ---------------------------------------------------------------------------
  const runImport = async () => {
    if (!preview || rows.length === 0) return;
    if (unknownCount > 0) {
      setMessage({
        ok: false,
        text: "未登録のクリエイターがあります。先に登録または別名設定を行ってください。",
      });
      return;
    }

    setBusy("import");
    setMessage(null);
    setSummary(null);

    const known = new Set(
      rows
        .map((row) => normalizeTiktokId(row.creatorTikTokId ?? ""))
        .filter((id) => !preview.unknownCreators.some((u) => u.tiktokId === id)),
    );
    const linked = rows.filter((row) =>
      known.has(normalizeTiktokId(row.creatorTikTokId ?? "")),
    );
    const { chunks } = buildPayloadChunks(linked);

    let batchId = "";
    try {
      const started = await startTapAffiliateOrderImportAction({
        fileName: preview.fileName,
        fileHash: preview.fileHash,
        rowCount: linked.length,
        chunkCount: chunks.length,
        unknownCreatorCount: unknownCount,
      });

      if (!started.ok) {
        setMessage({ ok: false, text: started.error });
        return;
      }
      batchId = started.batchId;

      /*
        前回の続きから送る。成功済みのチャンクは送り直さない。
        送り直しても upsert なので結果は壊れないが、無駄な往復を避ける。
      */
      const done = new Set(started.resumedChunkIndexes);
      let inserted = 0;

      for (let index = 0; index < chunks.length; index += 1) {
        if (done.has(index)) continue;
        setProgress(`取込中… ${index + 1} / ${chunks.length}`);

        const result = await importTapAffiliateOrderChunkAction({
          batchId,
          chunkIndex: index,
          rows: chunks[index],
        });

        if (!result.ok) {
          await failTapAffiliateOrderImportAction({ batchId, message: result.error });
          setMessage({
            ok: false,
            text: `${index + 1} / ${chunks.length} 件目で失敗しました: ${result.error}　同じファイルをもう一度選ぶと続きから再開できます。`,
          });
          return;
        }
        inserted += result.upsertedCount;
      }

      setProgress("仕上げています…");
      const finished = await finishTapAffiliateOrderImportAction({
        batchId,
        insertedCount: inserted,
        skippedCount: preview.skippedRowCount,
      });

      if (!finished.ok) {
        setMessage({ ok: false, text: finished.error });
        return;
      }

      setSummary({
        insertedCount: inserted,
        skippedCount: preview.skippedRowCount,
        chunkCount: chunks.length,
        aliasedRowCount: preview.aliasedRowCount,
        periodStart: preview.periodStart,
        periodEnd: preview.periodEnd,
      });
      setMessage({ ok: true, text: finished.message });
      setPreview(null);
      setRows([]);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (batchId) await failTapAffiliateOrderImportAction({ batchId, message: text });
      setMessage({ ok: false, text: `取込に失敗しました: ${text}` });
    } finally {
      setBusy(null);
      setProgress("");
    }
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
          Excelはブラウザで読み取り、
          {int(MAX_CHUNK_ROWS)} 行ごとに分けて送信します。
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
          disabled={busy !== null}
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
            onClick={runPreview}
            disabled={!file || busy !== null}
            className="min-h-[40px] rounded-lg bg-[var(--accent-cyan)] px-4 text-sm font-semibold text-black disabled:opacity-50"
          >
            {busy === "preview" ? "確認中…" : "プレビュー"}
          </button>
          <button
            type="button"
            onClick={runImport}
            disabled={!canConfirm}
            className="min-h-[40px] rounded-lg border border-white/[0.12] px-4 text-sm font-medium text-zinc-100 hover:bg-white/[0.06] disabled:opacity-40"
          >
            {busy === "import" ? "取込中…" : "確定取込"}
          </button>
          {progress ? (
            <span className="text-[11px] text-zinc-400">{progress}</span>
          ) : !preview ? (
            <span className="text-[11px] text-zinc-500">
              先にプレビューで内容を確認してください。
            </span>
          ) : null}
        </div>
      </section>

      {/* ---------------- メッセージ ---------------- */}
      {message ? (
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
            message.ok
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/25 bg-red-500/10 text-red-200"
          }`}
        >
          {message.text}
        </p>
      ) : null}

      {/* ---------------- 取込結果 ---------------- */}
      {summary ? (
        <section className={card}>
          <h2 className="text-sm font-semibold text-zinc-200">取込結果</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="取り込んだ行" value={int(summary.insertedCount)} />
            <Stat label="スキップ（未紐付け）" value={int(summary.skippedCount)} />
            <Stat label="送信回数" value={int(summary.chunkCount)} />
            <Stat label="別名で寄せた行" value={int(summary.aliasedRowCount)} />
          </div>
          {summary.periodStart ? (
            <p className="mt-3 text-[11px] text-zinc-500">
              対象期間 {summary.periodStart} 〜 {summary.periodEnd}
            </p>
          ) : null}
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
              <Stat label="スキップ（未紐付け）" value={int(preview.skippedRowCount)} />
              <Stat label="成果報酬ベース総額" value={yen(preview.commissionBaseTotal)} />
              <Stat label="クリエイター数" value={int(preview.creatorCount)} />
              <Stat label="既知クリエイター" value={int(preview.knownCreatorCount)} />
              <Stat label="別名で寄せた行" value={int(preview.aliasedRowCount)} />
              <Stat label="未登録クリエイター" value={int(unknownCount)} />
            </div>
            <p className="mt-3 text-[11px] text-zinc-500">
              {int(preview.chunkCount)} 回に分けて送信します（最大{" "}
              {int(Math.round(preview.maxChunkBytes / 1024))} KB /{" "}
              {int(MAX_CHUNK_ROWS)} 行、上限{" "}
              {int(Math.round(MAX_CHUNK_PAYLOAD_BYTES / 1024))} KB）。
            </p>
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
                  {preview.monthCounts.map((month) => (
                    <tr key={month.month} className="border-b border-zinc-800/70">
                      <td className={`${td} font-mono text-zinc-100`}>{month.month}</td>
                      <td className={`${td} text-right text-zinc-300`}>
                        {int(month.rowCount)}
                      </td>
                      <td className={`${td} text-right text-zinc-300`}>
                        {yen(month.commissionBase)}
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
                {preview.excludedCounts.map((excluded) => (
                  <li key={excluded.reason}>
                    {TAP_EXCLUSION_LABEL[
                      excluded.reason as keyof typeof TAP_EXCLUSION_LABEL
                    ] ?? excluded.reason}
                    ：{int(excluded.rowCount)} 行
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
                {preview.appliedAliases.map((alias) => (
                  <li key={`${alias.from}-${alias.to}`}>
                    {alias.from} → {alias.to}（{int(alias.rowCount)} 行）
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
                    {preview.unknownCreators.map((creator) => (
                      <tr key={creator.tiktokId} className="border-b border-zinc-800/70">
                        <td className={`${td} font-mono text-zinc-100`}>
                          {creator.tiktokId}
                        </td>
                        <td className={`${td} text-right text-zinc-300`}>
                          {int(creator.rowCount)}
                        </td>
                        <td className={`${td} text-right text-zinc-300`}>
                          {yen(creator.commissionBase)}
                        </td>
                        <td className={`${td} text-zinc-400`}>
                          {creator.months.join(", ")}
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
