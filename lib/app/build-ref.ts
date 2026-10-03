/*
  いま動いているビルドの識別子。

  Vercel はビルド時に VERCEL_GIT_COMMIT_SHA と VERCEL_ENV を渡すので、
  それを読むだけ。ローカルでは値が無いので "local" を返す。

  デプロイの成否ではなく「実ブラウザがどの版を見ているか」を
  確かめるために使う。2026-10-03 に、push 済み・デプロイ success でも
  別画面を見ていたことに気づくまで時間がかかったため入れた。
*/
export type BuildRef = {
  /** commit の短縮 SHA。取れなければ "local" */
  commit: string;
  /** production / preview / development。取れなければ null */
  env: string | null;
};

export function resolveBuildRef(): BuildRef {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  const env = process.env.VERCEL_ENV?.trim();

  return {
    commit: sha ? sha.slice(0, 7) : "local",
    env: env ? env : null,
  };
}
