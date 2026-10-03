import { resolveBuildRef } from "@/lib/app/build-ref";

/*
  いま表示しているページがどのビルドかを管理者だけに見せる小さな表示。

  ■ なぜ必要か
  「コードは push した / デプロイは success」と「実ブラウザがその版を
  配信されている」は別で、後者をブラウザから確かめる手段が無かった。
  2026-10-03 に、別画面を見ていたことに気づくまで時間がかかった。

  表示だけで、何も書き込まない。
*/
export function BuildMarker({ page }: { page: string }) {
  const ref = resolveBuildRef();

  return (
    <p className="text-center text-[10px] text-zinc-600">
      <span className="font-mono">{page}</span>
      {" / Build: "}
      <span className="font-mono">{ref.commit}</span>
      {ref.env ? ` / ${ref.env}` : null}
    </p>
  );
}
