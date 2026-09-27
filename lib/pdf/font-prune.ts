import fontkit from "@pdf-lib/fontkit";

/*
  TrueTypeフォントから、使わない字の輪郭だけを取り除く。

  ■ なぜ自前で用意するのか
  pdf-lib の embedFont({ subset: true }) は、この日本語フォントに対して
  壊れたサブセットを作る。PDF の文字情報（テキスト抽出）は正しいまま、
  字の輪郭だけが別物になるため、テキスト抽出では気付けず、
  画面で見て初めて分かる。実際に大半の字が空白で表示された。

  ■ この方式が安全な理由
  グリフ番号を振り直さない。cmap も hmtx も元のまま残し、
  glyf（字の輪郭）だけを「使う字だけ中身あり、他は長さ0」に置き換える。
  番号の対応表を作り直さないので、対応がずれようがない。
  pdf-lib へは subset: false で渡す（pdf-lib 側のサブセット処理を通さない）。

  ■ 大きさ
  元は 5.0MB（うち glyf が 4.8MB）。1枚の明細書で使う字は数百なので、
  間引いた結果は 300KB 前後になる。
*/

const TAG_HEAD = "head";
const TAG_MAXP = "maxp";
const TAG_LOCA = "loca";
const TAG_GLYF = "glyf";

type Table = { tag: string; offset: number; length: number; checksum: number };

type ParsedFont = {
  glyphForCodePoint: (cp: number) => { id: number } | undefined;
};

/*
  5MBのフォントを毎回読み直すと、まとめ出力のときに同じ解析を何度も行う。
  同じバイト列なら解析結果を使い回す。
*/
let cachedSource: Uint8Array | null = null;
let cachedParsed: ParsedFont | null = null;

function parseFont(bytes: Uint8Array): ParsedFont {
  if (cachedSource === bytes && cachedParsed) return cachedParsed;
  cachedParsed = fontkit.create(Buffer.from(bytes)) as unknown as ParsedFont;
  cachedSource = bytes;
  return cachedParsed;
}

function readTableDirectory(view: DataView): Table[] {
  const numTables = view.getUint16(4);
  const tables: Table[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    let tag = "";
    for (let j = 0; j < 4; j += 1) tag += String.fromCharCode(view.getUint8(base + j));
    tables.push({
      tag,
      checksum: view.getUint32(base + 4),
      offset: view.getUint32(base + 8),
      length: view.getUint32(base + 12),
    });
  }
  return tables;
}

/** 4バイト境界へ切り上げる。sfnt は各テーブルをこの境界に置く */
function align4(value: number): number {
  return (value + 3) & ~3;
}

/** sfnt のチェックサム。4バイトずつ足し込む */
function checksum(bytes: Uint8Array, offset: number, length: number): number {
  let sum = 0;
  const end = offset + length;
  for (let i = offset; i < end; i += 4) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/**
 * 合成グリフが参照している元のグリフを集める。
 * 「氵＋青」のように、他の字を組み合わせて作られている字があるため、
 * 参照先を残さないと輪郭が欠ける。
 */
function collectComposites(
  bytes: Uint8Array,
  view: DataView,
  glyfOffset: number,
  locaOffsets: number[],
  glyphId: number,
  into: Set<number>,
): void {
  const start = locaOffsets[glyphId];
  const end = locaOffsets[glyphId + 1];
  if (end <= start) return; // 輪郭を持たない字

  const numberOfContours = view.getInt16(glyfOffset + start);
  if (numberOfContours >= 0) return; // 単独の字

  let cursor = glyfOffset + start + 10; // 輪郭数(2) + 外接矩形(8)
  for (;;) {
    const flags = view.getUint16(cursor);
    const componentId = view.getUint16(cursor + 2);
    cursor += 4;

    if (!into.has(componentId)) {
      into.add(componentId);
      collectComposites(bytes, view, glyfOffset, locaOffsets, componentId, into);
    }

    // ARG_1_AND_2_ARE_WORDS
    cursor += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008)
      cursor += 2; // WE_HAVE_A_SCALE
    else if (flags & 0x0040)
      cursor += 4; // WE_HAVE_AN_X_AND_Y_SCALE
    else if (flags & 0x0080) cursor += 8; // WE_HAVE_A_TWO_BY_TWO

    if (!(flags & 0x0020)) break; // MORE_COMPONENTS
  }
}

export type PruneResult = {
  bytes: Uint8Array;
  /** 残したグリフ数（合成グリフの参照先を含む） */
  keptGlyphs: number;
  totalGlyphs: number;
};

/**
 * 指定した文字の輪郭だけを残したフォントを作る。
 * グリフ番号・cmap・字幅は元のまま。
 */
export function pruneFontToCodePoints(
  fontBytes: Uint8Array,
  codePoints: Iterable<number>,
): PruneResult {
  const bytes =
    fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = readTableDirectory(view);

  const find = (tag: string) => {
    const table = tables.find((t) => t.tag === tag);
    if (!table) throw new Error(`フォントに ${tag} テーブルがありません。`);
    return table;
  };

  const head = find(TAG_HEAD);
  const maxp = find(TAG_MAXP);
  const loca = find(TAG_LOCA);
  const glyf = find(TAG_GLYF);

  const numGlyphs = view.getUint16(maxp.offset + 4);
  const indexToLocFormat = view.getInt16(head.offset + 50);

  // 元の loca を「バイト位置の配列」へ直す
  const locaOffsets: number[] = new Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i += 1) {
    locaOffsets[i] =
      indexToLocFormat === 0
        ? view.getUint16(loca.offset + i * 2) * 2
        : view.getUint32(loca.offset + i * 4);
  }

  /*
    文字からグリフ番号を引く。
    読み取りは fontkit に任せる（壊れているのは書き出し側のサブセット処理で、
    読み取りは正しく動く）。
  */
  const parsed = parseFont(bytes);

  const keep = new Set<number>([0]); // .notdef は必ず残す
  for (const cp of codePoints) {
    let glyph;
    try {
      glyph = parsed.glyphForCodePoint(cp);
    } catch {
      continue; // 収録されていない文字
    }
    if (glyph && glyph.id > 0 && glyph.id < numGlyphs) keep.add(glyph.id);
  }

  // 合成グリフの参照先も残す
  for (const id of [...keep]) {
    collectComposites(bytes, view, glyf.offset, locaOffsets, id, keep);
  }

  // 新しい glyf を組み立てる。残さない字は長さ0にする
  const newLoca = new Uint8Array((numGlyphs + 1) * 4); // 常に long 形式
  const newLocaView = new DataView(newLoca.buffer);
  const chunks: Uint8Array[] = [];
  let glyfLength = 0;

  for (let id = 0; id < numGlyphs; id += 1) {
    newLocaView.setUint32(id * 4, glyfLength);
    if (!keep.has(id)) continue;

    const start = locaOffsets[id];
    const end = locaOffsets[id + 1];
    if (end <= start) continue;

    const data = bytes.subarray(glyf.offset + start, glyf.offset + end);
    const padded = align4(data.length);
    const chunk = new Uint8Array(padded);
    chunk.set(data);
    chunks.push(chunk);
    glyfLength += padded;
  }
  newLocaView.setUint32(numGlyphs * 4, glyfLength);

  const newGlyf = new Uint8Array(glyfLength);
  {
    let cursor = 0;
    for (const chunk of chunks) {
      newGlyf.set(chunk, cursor);
      cursor += chunk.length;
    }
  }

  // ---------------------------------------------------------------------------
  // 書き出し
  // ---------------------------------------------------------------------------
  const output = tables.map((table) => {
    if (table.tag === TAG_GLYF) return { tag: table.tag, data: newGlyf };
    if (table.tag === TAG_LOCA) return { tag: table.tag, data: newLoca };
    if (table.tag === TAG_HEAD) {
      // loca を long 形式にしたので head も合わせる
      const copy = bytes.slice(table.offset, table.offset + table.length);
      new DataView(copy.buffer).setInt16(50, 1);
      // checkSumAdjustment は最後に入れ直すので0にしておく
      new DataView(copy.buffer).setUint32(8, 0);
      return { tag: table.tag, data: copy };
    }
    return {
      tag: table.tag,
      data: bytes.slice(table.offset, table.offset + table.length),
    };
  });

  // タグ順に並べるのが sfnt の決まり
  output.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  const numTables = output.length;
  const directorySize = 12 + numTables * 16;
  const total =
    directorySize + output.reduce((sum, t) => sum + align4(t.data.length), 0);

  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);

  outView.setUint32(0, 0x00010000); // TrueType
  outView.setUint16(4, numTables);
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 2 ** entrySelector * 16;
  outView.setUint16(6, searchRange);
  outView.setUint16(8, entrySelector);
  outView.setUint16(10, numTables * 16 - searchRange);

  let cursor = directorySize;
  output.forEach((table, index) => {
    const base = 12 + index * 16;
    for (let j = 0; j < 4; j += 1) {
      outView.setUint8(base + j, table.tag.charCodeAt(j));
    }
    out.set(table.data, cursor);
    outView.setUint32(base + 4, checksum(out, cursor, align4(table.data.length)));
    outView.setUint32(base + 8, cursor);
    outView.setUint32(base + 12, table.data.length);
    cursor += align4(table.data.length);
  });

  /*
    ファイル全体のチェックサム。
    head の checkSumAdjustment に 0xB1B0AFBA から引いた値を入れる決まり。
  */
  const headIndex = output.findIndex((t) => t.tag === TAG_HEAD);
  if (headIndex >= 0) {
    const headOffset = outView.getUint32(12 + headIndex * 16 + 8);
    const whole = checksum(out, 0, out.length);
    outView.setUint32(headOffset + 8, (0xb1b0afba - whole) >>> 0);
  }

  return { bytes: out, keptGlyphs: keep.size, totalGlyphs: numGlyphs };
}
