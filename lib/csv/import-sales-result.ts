export const CSV_IMPORT_SUCCESS_MESSAGE = "CSV取込が完了しました";

export type ImportRowFailure = {
  rowNumber: number;
  error: string;
};

export type ImportCsvResult =
  | {
      ok: true;
      message: string;
      successCount: number;
      failedCount: number;
      rowsProcessed: number;
      creatorsTouched: number;
      failures: ImportRowFailure[];
    }
  | {
      ok: false;
      error: string;
      successCount?: number;
      failedCount?: number;
      failures?: ImportRowFailure[];
    };
