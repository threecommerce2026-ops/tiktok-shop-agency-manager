"use server";

import { ensureAgencyForUser } from "@/lib/db/agency-context";
import { insertCsvImportLog } from "@/lib/db/csv-import-log-queries";
import {
  buildCreatorLookup,
  resolveCreatorByTiktokId,
} from "@/lib/creators/resolve-creator-by-tiktok";
import {
  CSV_IMPORT_SUCCESS_MESSAGE,
  type ImportCsvResult,
  type ImportRowFailure,
} from "@/lib/csv/import-sales-result";
import { PARTNER_SALES_IMPORT_ERROR } from "@/lib/sales/partner-export-columns";
import { normalizeTiktokId } from "@/lib/sales/parse-partner-sales";
import { parsePartnerSalesFile } from "@/lib/sales/read-partner-upload";
import { normalizeTargetMonth } from "@/lib/sales/target-month";
import { createClient } from "@/lib/supabase/server";
import { mapSupabaseErrorToJa } from "@/lib/supabase/error-ja";
import { revalidatePath } from "next/cache";

type CreatorRef = {
  id: string;
  tiktokId: string;
};

export async function importSalesCsvAction(
  _prev: ImportCsvResult | null,
  formData: FormData,
): Promise<ImportCsvResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "ログインが必要です" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "CSV または XLSX ファイルを選択してください" };
  }

  const targetMonth = normalizeTargetMonth(String(formData.get("target_month") ?? ""));
  if (!targetMonth) {
    return {
      ok: false,
      error: "対象月を選択してください（例: 2026-05）。",
    };
  }

  const parsed = await parsePartnerSalesFile(file);
  if (!parsed.rows.length && !parsed.failures.length) {
    return { ok: false, error: PARTNER_SALES_IMPORT_ERROR };
  }

  const ctx = await ensureAgencyForUser(supabase, user.id);
  if (!ctx.data) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(
        ctx.error ?? "代理店情報を取得できませんでした。",
      ),
    };
  }

  const { agencyId } = ctx.data;
  const { data: existingCreators, error: creatorsLoadError } = await supabase
    .from("creators")
    .select("id, tiktok_id, agency_id, creator_name");

  if (creatorsLoadError) {
    return {
      ok: false,
      error: mapSupabaseErrorToJa(creatorsLoadError.message),
    };
  }

  const creatorLookup = buildCreatorLookup(
    (existingCreators ?? []).map((creator) => ({
      id: creator.id as string,
      tiktok_id: creator.tiktok_id as string,
      agency_id: (creator.agency_id as string | null) ?? null,
      creator_name: (creator.creator_name as string) ?? "",
    })),
  );

  const creatorByTiktok = new Map<string, CreatorRef>();
  for (const [tiktokId, creator] of creatorLookup) {
    creatorByTiktok.set(tiktokId, { id: creator.id, tiktokId });
  }

  const creatorIdsTouched = new Set<string>();
  const failures: ImportRowFailure[] = [...parsed.failures];
  let successCount = 0;

  async function resolveCreatorId(
    tiktokId: string,
    creatorName: string,
  ): Promise<{ ok: true; creatorId: string } | { ok: false; error: string }> {
    const resolved = await resolveCreatorByTiktokId(supabase, {
      tiktokId,
      creatorName,
      lookup: creatorLookup,
      autoCreate: true,
    });

    if (resolved.creator) {
      creatorByTiktok.set(tiktokId, {
        id: resolved.creator.id,
        tiktokId,
      });
      return { ok: true, creatorId: resolved.creator.id };
    }

    return {
      ok: false,
      error: mapSupabaseErrorToJa(
        resolved.error ?? "クリエイターの登録に失敗しました。",
      ),
    };
  }

  for (const row of parsed.rows) {
    const creator = await resolveCreatorId(row.tiktokId, row.creatorName);
    if (!creator.ok) {
      failures.push({ rowNumber: row.rowNumber, error: creator.error });
      continue;
    }

    const { error: salesError } = await supabase.from("sales_imports").upsert(
      {
        creator_id: creator.creatorId,
        agency_id: agencyId,
        target_month: targetMonth,
        sales_amount: row.salesYen,
        profit_amount: row.profitYen,
        order_count: row.orderCount,
        commission_base: row.commissionBase,
      },
      { onConflict: "creator_id,target_month" },
    );

    if (salesError) {
      failures.push({
        rowNumber: row.rowNumber,
        error: mapSupabaseErrorToJa(salesError.message),
      });
      continue;
    }

    creatorIdsTouched.add(creator.creatorId);
    successCount += 1;
  }

  const failedCount = failures.length;

  await insertCsvImportLog(supabase, {
    agencyId,
    uploadedBy: user.id,
    uploaderEmail: user.email ?? null,
    targetMonth,
    fileName: file.name,
    successCount,
    failedCount,
    failures,
  });

  if (successCount > 0) {
    revalidatePath("/dashboard");
    revalidatePath("/sales-upload");
    revalidatePath("/creators");
    revalidatePath("/sales");
    revalidatePath("/rewards");
    revalidatePath("/csv-logs");
    revalidatePath("/admin/creator-assignment");
  }

  if (successCount === 0) {
    return {
      ok: false,
      error:
        failedCount > 0
          ? `取り込みに成功した行がありません（失敗 ${failedCount} 件）。`
          : PARTNER_SALES_IMPORT_ERROR,
      successCount: 0,
      failedCount,
      failures,
    };
  }

  const message =
    failedCount > 0
      ? `${CSV_IMPORT_SUCCESS_MESSAGE}（成功 ${successCount} 件 / 失敗 ${failedCount} 件）`
      : CSV_IMPORT_SUCCESS_MESSAGE;

  return {
    ok: true,
    message,
    successCount,
    failedCount,
    rowsProcessed: successCount,
    creatorsTouched: creatorIdsTouched.size,
    failures,
  };
}
