import { readFileSync } from "node:fs";

import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  TextRenderingMode,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
  setLineWidth,
  setStrokingColor,
  setTextRenderingMode,
  type Color,
  type PDFPage,
} from "pdf-lib";

import { INVOICE_ISSUER } from "@/lib/billing/issuer";
import { pruneFontToCodePoints } from "@/lib/pdf/font-prune";
import {
  formatStatementCutoffLabel,
  formatStatementMonthLabel,
  formatStatementPeriodLabel,
  formatStatementRate,
  type AgencyStatement,
} from "@/lib/payments/agency-statement";

/*
  代理店報酬 支払明細書のPDF生成。

  ■ 報酬を再計算しない
  受け取るのは画面と同じ AgencyStatement（buildAgencyStatement の結果）だけ。
  金額の出どころは payment_batch と claim 済み agency_reward_items のみで、
  PDF用の別クエリ・別計算式を持たない。表示整形も agency-statement.ts の
  関数をそのまま使うので、画面とPDFで数字の見え方がずれない。

  ■ 画面の帳票と内容を合わせる
  components/payments/AgencyStatementDocument.tsx と同じ項目・同じ文言を出す。
  片方だけ直すと画面とPDFが食い違うので、文言を変えるときは両方を直す。

  ■ 載せないもの
  ・紹介制度報酬（代理店への支払対象外）
  ・口座番号・口座名義・銀行名・支店名（帳票は「登録済みか」しか持たない）
  ・消費税 / 源泉徴収 / 請求書番号（システムに正式情報がない）

  ■ 文字が欠けないようにする
  金額は縮小して必ず全桁を出す。名前は入る幅で切って省略記号を付ける。
  フォントに無い文字（TikTok名の絵文字など）は事前に落とす。
  pdf-lib は未収録文字で例外を投げるため、この処理は必須。

  ■ フォントの埋め込み
  pdf-lib の subset: true は、この日本語フォントで壊れた結果を作る
  （テキストは正しいのに字の輪郭だけが別物になる）。
  そのため lib/pdf/font-prune.ts で必要な字だけを残したフォントを作り、
  pdf-lib へは subset: false で渡す。グリフ番号を振り直さないので
  対応がずれない。最後に「描いた字がすべて入っているか」を確かめ、
  1文字でも欠けていれば PDF を返さずエラーにする。
*/

// A4縦（pt）
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = rgb(0.094, 0.094, 0.106); // #18181b
const SUB = rgb(0.325, 0.325, 0.353); // #52525b
const MUTED = rgb(0.443, 0.443, 0.478); // #71717a
const LINE = rgb(0.831, 0.831, 0.847); // #d4d4d8
const FILL = rgb(0.957, 0.957, 0.961); // #f4f4f5
const FILL_SOFT = rgb(0.98, 0.98, 0.98); // #fafafa

/*
  表の列。合計を CONTENT_WIDTH（515pt）に合わせる。
  幅は 8pt での実測値から決めた。入りきらない場合の扱いを列ごとに持つ:
    shrink … 文字を小さくして全部見せる（金額・期間。桁や月を落とさない）
    clip   … 入る分だけ出して省略記号を付ける（名前。長さの上限が読めない）
*/
const COLUMNS = [
  { key: "creator", label: "クリエイター", width: 160, align: "left", fit: "clip" },
  { key: "period", label: "対象期間", width: 96, align: "left", fit: "shrink" },
  { key: "gmv", label: "GMV（参考）", width: 66, align: "right", fit: "shrink" },
  { key: "base", label: "分配計算基準額", width: 66, align: "right", fit: "shrink" },
  { key: "rate", label: "分配率", width: 36, align: "right", fit: "shrink" },
  { key: "reward", label: "代理店分配報酬", width: 91, align: "right", fit: "shrink" },
] as const;

const TABLE_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0);

const CELL_PAD = 5;
const ROW_HEIGHT = 16;
const HEADER_HEIGHT = 18;
const BODY_SIZE = 8;
const HEADER_SIZE = 7.5;
/** これ以上は縮めない。読めなくなるため */
const MIN_SIZE = 5.5;

/*
  フォントはリポジトリ内のファイルを読む。
  実行時に外部CDNへ取りに行かない（ネットワーク断で帳票が出せなくなる、
  取得先の都合で字形が変わる、という事故を避ける）。

  new URL(..., import.meta.url) で参照すると、Next のビルドが
  サーバー側の出力へこのファイルを含めてくれる。
*/
const FONT_PATH = new URL("./fonts/NotoSansJP-Regular.ttf", import.meta.url);

let fontBytesCache: Uint8Array | null = null;

function loadFontBytes(): Uint8Array {
  if (!fontBytesCache) fontBytesCache = readFileSync(FONT_PATH);
  return fontBytesCache;
}

/*
  帳票が描く固定文言。フォントを間引くときに残す対象を決めるために使う。
  ここに載せ漏れがあっても、字が消えたまま出ることはない。
  描いた字がフォントに無ければ、最後の確認で必ずエラーになる。
*/
const TEMPLATE_TEXT = [
  "代理店報酬 支払明細書",
  "締め ／ 対象期間 年月末〜",
  "代理店名",
  " 御中",
  "下記のとおり、代理店分配報酬をお支払いいたします。",
  "発行日",
  "TEL ",
  "登録番号 ",
  "お支払金額",
  "内訳（クリエイター別 ／ 対象  明細）",
  "クリエイター",
  "対象期間",
  "GMV（参考）",
  "分配計算基準額",
  "分配率",
  "代理店分配報酬",
  "複数",
  "合計（代理店分配報酬）",
  "お振込先",
  "ご登録いただいている口座へお振り込みいたします。",
  "お振込先が未登録です。口座情報をご連絡ください。",
  "ご確認事項",
  "※GMVは参考値です。代理店分配報酬は、TikTok Shop側で確定した実績に基づく金額を記載しています。",
  "※明細単位の端数処理により、「分配計算基準額 × 分配率」と代理店分配報酬が一致しない場合があります。",
  "※最低支払額は円です。未払報酬の累計が円未満の場合は、翌月以降へ繰り越されます。",
  "支払明細番号 ",
  " ページ",
  "　/ ",
  "—…¥%",
  INVOICE_ISSUER.companyName,
  INVOICE_ISSUER.postalCode,
  INVOICE_ISSUER.address,
  INVOICE_ISSUER.tel,
  INVOICE_ISSUER.registrationNumber,
].join("");

/**
 * この明細書で必要になる文字を集める。
 * 固定文言、明細のデータ、そして ASCII 全体（ID や数字のため）。
 */
function collectCodePoints(statement: AgencyStatement): Set<number> {
  const codePoints = new Set<number>();
  const add = (text: string) => {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined) codePoints.add(cp);
    }
  };

  // ASCII は ID・数字・記号で必ず使う
  for (let cp = 0x20; cp <= 0x7e; cp += 1) codePoints.add(cp);

  add(TEMPLATE_TEXT);
  add(statement.agencyName);
  add(statement.batchId);
  add(statement.cutoffMonth);
  for (const creator of statement.creators) {
    add(creator.creatorName);
    add(creator.tiktokId);
    add(creator.periodStartMonth);
    add(creator.periodEndMonth);
    for (const month of creator.months) add(month.targetMonth);
  }
  return codePoints;
}

const yen = (value: number) => `¥${Math.round(value).toLocaleString("ja-JP")}`;

/** 基準額・GMVは実額のまま2桁で出す（丸めて根拠を変えない） */
const exact = (value: number) =>
  `¥${value.toLocaleString("ja-JP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function jstDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 生成中に落とした文字。呼び出し側が件数を把握できるようにする */
export type PdfRenderReport = {
  /** フォントに無くて除いた文字 */
  droppedCharacters: string[];
  /** 幅に入らず省略した箇所 */
  truncatedTexts: string[];
  pageCount: number;
  /** 埋め込んだフォントの大きさ */
  fontBytes: number;
  /** 輪郭を残したグリフ数 */
  keptGlyphs: number;
};

/**
 * 1代理店ぶんの支払明細書PDFを作る。
 * 金額は AgencyStatement の値をそのまま使い、ここで計算し直さない。
 */
export async function renderAgencyStatementPdf(
  statement: AgencyStatement,
  minimumPayoutYen: number,
): Promise<{ bytes: Uint8Array; report: PdfRenderReport }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  /*
    必要な字だけを残したフォントを作って埋め込む。
    pdf-lib のサブセット処理は通さない（この日本語フォントで壊れるため）。
  */
  const codePoints = collectCodePoints(statement);
  const pruned = pruneFontToCodePoints(loadFontBytes(), codePoints);
  const font = await doc.embedFont(pruned.bytes, { subset: false });

  const report: PdfRenderReport = {
    droppedCharacters: [],
    truncatedTexts: [],
    pageCount: 0,
    fontBytes: pruned.bytes.length,
    keptGlyphs: pruned.keptGlyphs,
  };

  /*
    実際に描いた字のうち、間引きで輪郭を落としてしまったもの。
    1つでもあれば字が空白で出るので、PDFを返さずエラーにする。
  */
  const missingGlyphs = new Set<string>();

  /*
    フォントに無い文字を落とす。
    pdf-lib は未収録文字で例外になるため、描く前に必ず通す。
    TikTok の表示名には絵文字が入ることがあり、文字フォントでは出せない。
  */
  const supported = new Set<number>();
  for (const cp of font.getCharacterSet()) supported.add(cp);

  const safe = (input: string): string => {
    let out = "";
    for (const ch of input) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (!supported.has(cp)) {
        // フォントに無い字（TikTok名の絵文字など）は載せられない
        if (!report.droppedCharacters.includes(ch)) report.droppedCharacters.push(ch);
        continue;
      }
      // 輪郭を残していない字は空白で出てしまうので、印ではなく異常として扱う
      if (!codePoints.has(cp)) missingGlyphs.add(ch);
      out += ch;
    }
    return out;
  };

  const widthOf = (text: string, size: number) =>
    font.widthOfTextAtSize(text, size);

  /** 幅に入るまで文字を落として省略記号を付ける（名前向け） */
  const clip = (text: string, maxWidth: number, size: number): string => {
    if (widthOf(text, size) <= maxWidth) return text;
    const ellipsis = "…";
    const chars = [...text];
    let kept = "";
    for (const ch of chars) {
      if (widthOf(kept + ch + ellipsis, size) > maxWidth) break;
      kept += ch;
    }
    if (!report.truncatedTexts.includes(text)) report.truncatedTexts.push(text);
    return kept.length > 0 ? kept + ellipsis : ellipsis;
  };

  /** 幅に入るまで文字を小さくする（金額向け。桁を落とさない） */
  const shrink = (text: string, maxWidth: number, size: number): number => {
    let current = size;
    while (current > MIN_SIZE && widthOf(text, current) > maxWidth) {
      current -= 0.25;
    }
    return current;
  };

  // ---------------------------------------------------------------------------
  // 描画の道具
  // ---------------------------------------------------------------------------
  const pages: PDFPage[] = [];
  /*
    最初の1ページを先に作る。以降 newPage() が差し替える。
    「まだページが無い」状態を作らないことで、描画側の分岐を減らす。
  */
  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = PAGE_HEIGHT - MARGIN;
    return page;
  };

  type TextOptions = {
    size?: number;
    color?: Color;
    bold?: boolean;
    align?: "left" | "center" | "right";
    maxWidth?: number;
  };

  /** 塗りと輪郭で太さを出す。描画は1回だけ */
  const drawBold = (
    text: string,
    x: number,
    baseline: number,
    size: number,
    color: Color,
  ) => {
    page.pushOperators(
      pushGraphicsState(),
      setTextRenderingMode(TextRenderingMode.FillAndOutline),
      setLineWidth(size * 0.028),
      setStrokingColor(color),
    );
    page.drawText(text, { x, y: baseline, size, font, color });
    page.pushOperators(popGraphicsState());
  };

  const drawText = (raw: string, x: number, baseline: number, opts: TextOptions = {}) => {
    const text = safe(raw);
    if (text.length === 0) return;
    const size = opts.size ?? 9;
    const color = opts.color ?? INK;
    const width = widthOf(text, size);
    let left = x;
    if (opts.align === "center") left = x - width / 2;
    if (opts.align === "right") left = x - width;
    /*
      太字は1書体だけ持つため、輪郭を少し太らせて表す。
      ずらして二重に描く手もあるが、それをするとPDFから文字を取り出したとき
      同じ文字が2回出てしまう。会計処理で本文をコピーする用途を壊さないため、
      描画は1回だけにして塗り＋輪郭で太さを出す。
    */
    if (opts.bold) {
      drawBold(text, left, baseline, size, color);
    } else {
      page.drawText(text, { x: left, y: baseline, size, font, color });
    }
  };

  // ---------------------------------------------------------------------------
  // ヘッダー
  // ---------------------------------------------------------------------------
  const center = PAGE_WIDTH / 2;

  // タイトル。字間を空けて帳票らしく見せる
  {
    const title = safe("代理店報酬 支払明細書");
    const size = 16;
    const tracking = 3;
    /*
      字間は PDF の文字間隔で付ける。1文字ずつ描くとPDFから文字を取り出したとき
      タイトルが1文字ずつに割れてしまうため、まとめて1回で描く。
    */
    const total = widthOf(title, size) + tracking * ([...title].length - 1);
    page.pushOperators(pushGraphicsState(), setCharacterSpacing(tracking));
    drawBold(title, center - total / 2, y - size, size, INK);
    page.pushOperators(popGraphicsState());
    y -= size + 6;
  }

  const periodLabel = formatStatementPeriodLabel(
    statement.creators.reduce(
      (min, c) => (c.periodStartMonth < min ? c.periodStartMonth : min),
      statement.creators[0]?.periodStartMonth ?? statement.cutoffMonth,
    ),
    statement.creators.reduce(
      (max, c) => (c.periodEndMonth > max ? c.periodEndMonth : max),
      statement.creators[0]?.periodEndMonth ?? statement.cutoffMonth,
    ),
  );

  drawText(
    `${formatStatementCutoffLabel(statement.cutoffMonth)}締め ／ 対象期間 ${periodLabel}`,
    center,
    y - 8,
    { size: 8.5, color: SUB, align: "center" },
  );
  y -= 30;

  // 宛先（左）と発行元（右）
  const metaTop = y;
  {
    drawText("代理店名", MARGIN, y - 7, { size: 7, color: MUTED });
    y -= 18;
    const nameSize = 13;
    const nameText = clip(`${statement.agencyName} 御中`, 250, nameSize);
    drawText(nameText, MARGIN, y - nameSize + 3, { size: nameSize, bold: true });
    // 宛名の下線
    page.drawLine({
      start: { x: MARGIN, y: y - nameSize - 2 },
      end: { x: MARGIN + Math.max(200, widthOf(safe(nameText), nameSize) + 10), y: y - nameSize - 2 },
      thickness: 0.7,
      color: INK,
    });
    y -= nameSize + 14;
    drawText("下記のとおり、代理店分配報酬をお支払いいたします。", MARGIN, y - 7, {
      size: 8.5,
      color: SUB,
    });
    y -= 12;
  }

  {
    // 右側は上端から積む
    const right = PAGE_WIDTH - MARGIN;
    let ry = metaTop;
    drawText("発行日", right, ry - 7, { size: 7, color: MUTED, align: "right" });
    ry -= 13;
    drawText(jstDate(statement.approvedAt), right, ry - 8, {
      size: 9,
      align: "right",
    });
    ry -= 18;
    drawText(INVOICE_ISSUER.companyName, right, ry - 9, {
      size: 10.5,
      bold: true,
      align: "right",
    });
    ry -= 14;
    for (const line of [
      `${INVOICE_ISSUER.postalCode} ${INVOICE_ISSUER.address}`,
      `TEL ${INVOICE_ISSUER.tel}`,
      `登録番号 ${INVOICE_ISSUER.registrationNumber}`,
    ]) {
      drawText(line, right, ry - 8, { size: 8, color: SUB, align: "right" });
      ry -= 11.5;
    }
    y = Math.min(y, ry);
  }

  y -= 16;

  // ---------------------------------------------------------------------------
  // お支払金額
  // ---------------------------------------------------------------------------
  {
    const boxHeight = 34;
    page.drawRectangle({
      x: MARGIN,
      y: y - boxHeight,
      width: CONTENT_WIDTH,
      height: boxHeight,
      borderColor: INK,
      borderWidth: 0.8,
    });
    drawText("お支払金額", MARGIN + 14, y - 21, { size: 9.5, bold: true });
    const amount = yen(statement.paymentAmount);
    const size = shrink(amount, CONTENT_WIDTH - 140, 20);
    drawText(amount, PAGE_WIDTH - MARGIN - 14, y - 24, {
      size,
      bold: true,
      align: "right",
    });
    y -= boxHeight + 22;
  }

  // ---------------------------------------------------------------------------
  // 内訳
  // ---------------------------------------------------------------------------
  const sectionTitle = (label: string) => {
    // 見出しの左に縦棒
    page.drawRectangle({
      x: MARGIN,
      y: y - 10,
      width: 2.2,
      height: 10,
      color: INK,
    });
    drawText(label, MARGIN + 7, y - 9, { size: 9.5, bold: true });
    y -= 20;
  };

  sectionTitle(
    `内訳（クリエイター別 ／ 対象 ${statement.itemCount.toLocaleString("ja-JP")} 明細）`,
  );

  const columnX: number[] = [];
  {
    let x = MARGIN;
    for (const col of COLUMNS) {
      columnX.push(x);
      x += col.width;
    }
  }

  const drawRow = (
    cells: string[],
    options: {
      height?: number;
      size?: number;
      bold?: boolean;
      fill?: Color | null;
      color?: Color;
      indentFirst?: number;
      /** false にすると縮小せず、見出しのように固定サイズで出す */
      shrinkToFit?: boolean;
    } = {},
  ) => {
    const height = options.height ?? ROW_HEIGHT;
    const size = options.size ?? BODY_SIZE;
    const top = y;
    const bottom = y - height;

    if (options.fill) {
      page.drawRectangle({
        x: MARGIN,
        y: bottom,
        width: TABLE_WIDTH,
        height,
        color: options.fill,
      });
    }

    // 枠線（外枠 + 縦の区切り）
    page.drawRectangle({
      x: MARGIN,
      y: bottom,
      width: TABLE_WIDTH,
      height,
      borderColor: LINE,
      borderWidth: 0.5,
    });
    for (let i = 1; i < COLUMNS.length; i += 1) {
      page.drawLine({
        start: { x: columnX[i], y: bottom },
        end: { x: columnX[i], y: top },
        thickness: 0.5,
        color: LINE,
      });
    }

    const baseline = bottom + (height - size) / 2 + 1.2;

    COLUMNS.forEach((col, index) => {
      const raw = cells[index] ?? "";
      if (raw === "") return;
      const indent = index === 0 ? (options.indentFirst ?? 0) : 0;
      const maxWidth = col.width - CELL_PAD * 2 - indent;

      if (col.fit === "shrink" && options.shrinkToFit !== false) {
        // 桁や月を落とさず、入るまで小さくする
        const cellSize = shrink(safe(raw), maxWidth, size);
        const x =
          col.align === "right"
            ? columnX[index] + col.width - CELL_PAD
            : columnX[index] + CELL_PAD + indent;
        drawText(raw, x, baseline, {
          size: cellSize,
          bold: options.bold,
          color: options.color,
          align: col.align === "right" ? "right" : "left",
        });
      } else {
        drawText(clip(safe(raw), maxWidth, size), columnX[index] + CELL_PAD + indent, baseline, {
          size,
          bold: options.bold,
          color: options.color,
        });
      }
    });

    y -= height;
  };

  const drawTableHeader = () => {
    drawRow(
      COLUMNS.map((c) => c.label),
      {
        height: HEADER_HEIGHT,
        size: HEADER_SIZE,
        bold: true,
        fill: FILL,
        color: rgb(0.247, 0.247, 0.275),
        shrinkToFit: false,
      },
    );
  };

  /*
    下部に残す高さ。合計行・振込先・注記・フッターを置く場所を確保する。
    足りなければ改ページして表の見出しを出し直す。
  */
  const RESERVED_BOTTOM = 150;

  const ensureSpace = (needed: number) => {
    if (y - needed >= MARGIN + RESERVED_BOTTOM) return;
    newPage();
    drawTableHeader();
  };

  drawTableHeader();

  for (const creator of statement.creators) {
    const monthRows = creator.months.length > 1 ? creator.months.length : 0;
    // クリエイター行と月内訳は同じページに収める
    ensureSpace(ROW_HEIGHT * (1 + monthRows));

    /*
      表示名がそのまま TikTok ID のことが多い。同じなら @ を重ねない。
      重ねると列に入らず、かえって ID が切れて誰の分か分からなくなる。
    */
    const handle =
      creator.tiktokId && creator.tiktokId !== creator.creatorName
        ? ` @${creator.tiktokId}`
        : "";
    drawRow(
      [
        `${creator.creatorName}${handle}`,
        formatStatementPeriodLabel(creator.periodStartMonth, creator.periodEndMonth),
        exact(creator.gmv),
        exact(creator.baseAmount),
        formatStatementRate(creator.ratePct),
        exact(creator.rewardAmount),
      ],
      { bold: false },
    );

    // 月が1つだけなら上の行と同じ内容になるので出さない
    if (monthRows > 0) {
      for (const month of creator.months) {
        drawRow(
          [
            formatStatementMonthLabel(month.targetMonth),
            `${month.itemCount.toLocaleString("ja-JP")} 明細`,
            exact(month.gmv),
            exact(month.baseAmount),
            formatStatementRate(month.hasMixedRate ? null : month.ratePct),
            exact(month.rewardAmount),
          ],
          { fill: FILL_SOFT, color: SUB, indentFirst: 10, size: 7.5 },
        );
      }
    }
  }

  // 合計
  ensureSpace(ROW_HEIGHT + 4);
  {
    const height = ROW_HEIGHT + 2;
    const bottom = y - height;
    page.drawRectangle({
      x: MARGIN,
      y: bottom,
      width: TABLE_WIDTH,
      height,
      color: FILL,
      borderColor: LINE,
      borderWidth: 0.5,
    });
    page.drawLine({
      start: { x: MARGIN, y: y },
      end: { x: MARGIN + TABLE_WIDTH, y: y },
      thickness: 1.2,
      color: INK,
    });
    const baseline = bottom + (height - BODY_SIZE) / 2 + 1.2;
    drawText("合計（代理店分配報酬）", MARGIN + CELL_PAD, baseline, {
      size: BODY_SIZE,
      bold: true,
    });
    const total = yen(statement.agencyRewardAmount);
    const lastX = columnX[COLUMNS.length - 1];
    const totalSize = shrink(
      total,
      COLUMNS[COLUMNS.length - 1].width - CELL_PAD * 2,
      BODY_SIZE,
    );
    page.drawLine({
      start: { x: lastX, y: bottom },
      end: { x: lastX, y },
      thickness: 0.5,
      color: LINE,
    });
    drawText(total, lastX + COLUMNS[COLUMNS.length - 1].width - CELL_PAD, baseline, {
      size: totalSize,
      bold: true,
      align: "right",
    });
    y -= height;
  }

  y -= 20;

  // ---------------------------------------------------------------------------
  // お振込先
  // ---------------------------------------------------------------------------
  sectionTitle("お振込先");
  drawText(
    statement.bankRegistered
      ? "ご登録いただいている口座へお振り込みいたします。"
      : "お振込先が未登録です。口座情報をご連絡ください。",
    MARGIN,
    y - 8,
    { size: 8.5, color: SUB },
  );
  y -= 24;

  // ---------------------------------------------------------------------------
  // ご確認事項
  // ---------------------------------------------------------------------------
  {
    drawText("ご確認事項", MARGIN, y - 8, { size: 8.5, bold: true });
    y -= 14;

    const threshold = minimumPayoutYen.toLocaleString("ja-JP");
    const notes = [
      "※GMVは参考値です。代理店分配報酬は、TikTok Shop側で確定した実績に基づく金額を記載しています。",
      "※明細単位の端数処理により、「分配計算基準額 × 分配率」と代理店分配報酬が一致しない場合があります。",
      `※最低支払額は${threshold}円です。未払報酬の累計が${threshold}円未満の場合は、翌月以降へ繰り越されます。`,
    ];

    const size = 7.8;
    const lineHeight = 11;
    for (const note of notes) {
      // 幅で折り返す。2行目以降は ※ のぶん下げて行頭を揃える
      const hangingIndent = widthOf(safe("※"), size);
      let first = true;
      let current = "";
      const flush = () => {
        drawText(current, MARGIN + (first ? 0 : hangingIndent), y - size, {
          size,
          color: SUB,
        });
        y -= lineHeight;
        first = false;
        current = "";
      };
      for (const ch of safe(note)) {
        const limit = CONTENT_WIDTH - (first ? 0 : hangingIndent);
        if (widthOf(current + ch, size) > limit) flush();
        current += ch;
      }
      if (current.length > 0) flush();
      y -= 2;
    }
  }

  // ---------------------------------------------------------------------------
  // フッター（全ページ）
  // ---------------------------------------------------------------------------
  report.pageCount = pages.length;
  pages.forEach((target, index) => {
    const footerY = MARGIN - 14;
    target.drawLine({
      start: { x: MARGIN, y: MARGIN - 6 },
      end: { x: PAGE_WIDTH - MARGIN, y: MARGIN - 6 },
      thickness: 0.5,
      color: LINE,
    });
    const left = safe(INVOICE_ISSUER.companyName);
    target.drawText(left, { x: MARGIN, y: footerY, size: 7, font, color: MUTED });

    const right = safe(
      pages.length > 1
        ? `支払明細番号 ${statement.batchId}　${index + 1} / ${pages.length} ページ`
        : `支払明細番号 ${statement.batchId}`,
    );
    target.drawText(right, {
      x: PAGE_WIDTH - MARGIN - widthOf(right, 7),
      y: footerY,
      size: 7,
      font,
      color: MUTED,
    });
  });

  doc.setTitle(`代理店報酬 支払明細書 ${statement.agencyName}`);
  doc.setCreator(INVOICE_ISSUER.companyName);
  doc.setProducer(INVOICE_ISSUER.companyName);
  doc.setSubject(`${statement.cutoffMonth} 締め 代理店分配報酬`);

  /*
    描いた字がすべてフォントに入っているかの最終確認。
    ここを通さないと、字が空白のPDFをそのまま代理店へ渡してしまう。
  */
  if (missingGlyphs.size > 0) {
    throw new Error(
      `支払明細書のPDFに含められない文字があります: ${[...missingGlyphs].join("")}`,
    );
  }

  return { bytes: await doc.save(), report };
}
