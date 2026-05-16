/**
 * PostgREST / Supabase の英語メッセージを、画面向けに日本語へ寄せる
 */
export function mapSupabaseErrorToJa(message: string): string {
  const m = message.trim();

  if (/relation .* does not exist/i.test(m) || /Could not find the table/i.test(m)) {
    return "データベースに必要なテーブルがありません。Supabase の SQL Editor で agency_revenue_schema.sql を実行してください。";
  }

  if (/row-level security/i.test(m) || /new row violates row-level security/i.test(m)) {
    return "保存が拒否されました（アクセス権限）。ログイン状態と agency_revenue_schema.sql の RLS を確認してください。";
  }

  if (/duplicate key value violates unique constraint/i.test(m)) {
    return "同じデータが既に存在します（一意制約違反）。対象月と TikTok ID の組み合わせを確認してください。";
  }

  if (/JWT expired|Invalid JWT|jwt expired/i.test(m)) {
    return "ログインの有効期限が切れています。一度ログアウトしてから再度ログインしてください。";
  }

  if (/violates foreign key constraint/i.test(m)) {
    return "関連データの参照に失敗しました。代理店・クリエイターのデータを確認してください。";
  }

  if (/invalid input syntax for type numeric/i.test(m)) {
    return "数値の形式が正しくありません。売上金額・収益金額・注文数は半角数字で入力してください。";
  }

  if (/violates check constraint/i.test(m) && /target_month/i.test(m)) {
    return "対象月の形式が正しくありません。YYYY-MM（例: 2026-05）で入力してください。";
  }

  if (/null value in column "name"/i.test(m)) {
    return "本名を入力してください。";
  }

  if (/null value in column/i.test(m)) {
    return "必須項目が未入力です。入力内容を確認してください。";
  }

  if (/User already registered|already been registered/i.test(m)) {
    return "このメールアドレスは既に登録されています。";
  }

  if (/Invalid login credentials/i.test(m)) {
    return "メールアドレスまたはパスワードが正しくありません。";
  }

  if (/Password should be at least/i.test(m)) {
    return "パスワードは 6 文字以上で入力してください。";
  }

  if (/network|fetch failed|Failed to fetch/i.test(m)) {
    return "Supabase への接続に失敗しました。ネットワークと環境変数（NEXT_PUBLIC_SUPABASE_URL 等）を確認してください。";
  }

  return m;
}
