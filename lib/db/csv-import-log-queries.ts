import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportRowFailure } from "@/lib/csv/import-sales-result";

export type CsvImportLogRow = {
  id: string;
  created_at: string;
  target_month: string;
  file_name: string;
  success_count: number;
  failed_count: number;
  failure_reasons: string | null;
  agency_id: string;
  agency_name: string;
  uploaded_by: string;
  uploader_email: string | null;
};

function unwrapAgency(value: unknown): { name: string } | null {
  if (!value) return null;
  if (Array.isArray(value)) return (value[0] as { name: string }) ?? null;
  return value as { name: string };
}

export async function fetchCsvImportLogs(
  supabase: SupabaseClient,
  options: { agencyId?: string | null; limit?: number } = {},
): Promise<{ data: CsvImportLogRow[]; error: string | null }> {
  const limit = options.limit ?? 80;
  let query = supabase
    .from("csv_import_logs")
    .select(
      `
      id,
      created_at,
      target_month,
      file_name,
      success_count,
      failed_count,
      failure_reasons,
      agency_id,
      uploaded_by,
      uploader_email,
      agencies ( name )
    `,
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (options.agencyId) {
    query = query.eq("agency_id", options.agencyId);
  }

  const { data, error } = await query;
  if (error) {
    return { data: [], error: error.message };
  }

  const rows: CsvImportLogRow[] = (data ?? []).map((row) => ({
    id: row.id as string,
    created_at: row.created_at as string,
    target_month: row.target_month as string,
    file_name: row.file_name as string,
    success_count: Number(row.success_count),
    failed_count: Number(row.failed_count),
    failure_reasons: (row.failure_reasons as string | null) ?? null,
    agency_id: row.agency_id as string,
    agency_name: unwrapAgency(row.agencies)?.name ?? "—",
    uploaded_by: row.uploaded_by as string,
    uploader_email: (row.uploader_email as string | null) ?? null,
  }));

  return { data: rows, error: null };
}

export function formatImportFailures(failures: ImportRowFailure[]): string {
  if (!failures.length) return "";
  return failures
    .map((failure) => `${failure.rowNumber}行目: ${failure.error}`)
    .join("\n");
}

export async function insertCsvImportLog(
  supabase: SupabaseClient,
  input: {
    agencyId: string;
    uploadedBy: string;
    uploaderEmail: string | null;
    targetMonth: string;
    fileName: string;
    successCount: number;
    failedCount: number;
    failures: ImportRowFailure[];
  },
): Promise<{ error: string | null }> {
  const { error } = await supabase.from("csv_import_logs").insert({
    agency_id: input.agencyId,
    uploaded_by: input.uploadedBy,
    uploader_email: input.uploaderEmail,
    target_month: input.targetMonth,
    file_name: input.fileName,
    success_count: input.successCount,
    failed_count: input.failedCount,
    failure_reasons: formatImportFailures(input.failures) || null,
  });

  return { error: error?.message ?? null };
}
