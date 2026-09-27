import { crc32, deflateRawSync } from "node:zlib";

/*
  最小限のZIP書き出し。

  ■ 依存関係を増やさない理由
  Node が deflateRawSync と crc32 を持っているため、ZIP の組み立てに
  外部ライブラリを足す必要がない。ZIP は仕様が固定なので、
  ここで完結させても将来壊れる余地が小さい。

  ■ 日本語ファイル名
  general purpose flag の bit 11（EFS）を立て、ファイル名を UTF-8 で書く。
  これを立てないと、展開側が CP932 と誤認して文字化けする。

  ■ ZIP64 は使わない
  1ファイル4GB・65,535エントリ未満で収まる用途しか想定しない。
  超える入力は呼び出し側で弾く。
*/

/** ZIPへ入れる1ファイル */
export type ZipEntry = {
  /** ZIP内のパス。区切りは "/" */
  name: string;
  data: Uint8Array;
};

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

/** DOS形式の日時。ZIPのヘッダはこの形式しか持てない */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  /*
    DOS時刻は1980年起点。それ以前は表現できないので下限へ丸める。
    秒は2秒単位しか持てない。
  */
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * ZIPを1つのバッファへ組み立てる。
 * 圧縮が効かないデータは無圧縮(store)で入れ、サイズが増えるのを避ける。
 */
export function createZip(entries: ZipEntry[], modifiedAt: Date): Uint8Array {
  if (entries.length === 0) {
    throw new Error("ZIPへ入れるファイルがありません。");
  }
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `ZIPへ入れるファイルが多すぎます（${entries.length} 件 / 上限 ${MAX_ENTRIES} 件）。`,
    );
  }

  const seen = new Set<string>();
  const { time, date } = dosDateTime(modifiedAt);

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.name.length === 0) {
      throw new Error("ZIP内のファイル名が空です。");
    }
    /*
      同名を通すと展開側で片方が消える。呼び出し側で一意にしてもらう。
    */
    if (seen.has(entry.name)) {
      throw new Error(`ZIP内のファイル名が重複しています: ${entry.name}`);
    }
    seen.add(entry.name);

    const nameBytes = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data);
    if (raw.length > MAX_BYTES) {
      throw new Error(`ファイルが大きすぎます: ${entry.name}`);
    }

    const deflated = deflateRawSync(raw, { level: 9 });
    // 縮まないなら無圧縮のまま入れる
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw) >>> 0;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(useDeflate ? 20 : 10, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // bit 11: ファイル名はUTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field なし
    nameBytes.copy(local, 30);

    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(0x031e, 4); // version made by (UNIX / 3.0)
    central.writeUInt16LE(useDeflate ? 20 : 10, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    /*
      JS のビット演算は32bit符号付きなので、そのまま書くと負値になる。
      符号なしへ戻してから入れる。
    */
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external attrs: 通常ファイル 644
    central.writeUInt32LE(offset, 42); // local header の位置
    nameBytes.copy(central, 46);

    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment

  return Buffer.concat([...locals, centralBytes, end]);
}

/**
 * ZIP内で名前がぶつからないようにする。
 * 上書きせず、2件目以降へ _2 / _3 を付ける。
 */
export function uniqueZipName(
  used: Set<string>,
  baseName: string,
  extension: string,
): string {
  let candidate = `${baseName}${extension}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${baseName}_${suffix}${extension}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}
