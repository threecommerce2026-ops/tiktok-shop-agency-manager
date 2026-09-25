import { createClient } from "@supabase/supabase-js";
import { fetchCreatorMonthlyFinance } from "@/lib/db/creator-monthly-finance-queries";

function yen(value: number) {
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}

function currentMonth() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;

  return `${year}-${month}`;
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase環境変数が設定されていません。");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export default async function MonthlyFinancePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;

  const targetMonth =
    params.month && /^\d{4}-\d{2}$/.test(params.month)
      ? params.month
      : currentMonth();

  const supabase = getSupabaseAdmin();

  const data = await fetchCreatorMonthlyFinance(
    supabase,
    targetMonth,
  );

  return (
    <main
      style={{
        padding: "32px",
        maxWidth: "1800px",
        margin: "0 auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 20,
          flexWrap: "wrap",
          marginBottom: 28,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 13,
              opacity: 0.55,
              marginBottom: 8,
            }}
          >
            CAP + TAP
          </div>

          <h1
            style={{
              fontSize: 30,
              fontWeight: 800,
              margin: 0,
            }}
          >
            クリエイター月次収支
          </h1>

          <p
            style={{
              marginTop: 10,
              opacity: 0.7,
            }}
          >
            CAP・TAP・クリエイター分配・紹介者報酬を
            月単位で集計します。
          </p>
        </div>

        <form method="GET">
          <label
            style={{
              display: "block",
              fontSize: 13,
              marginBottom: 6,
              opacity: 0.65,
            }}
          >
            対象月
          </label>

          <input
            type="month"
            name="month"
            defaultValue={targetMonth}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,.15)",
            }}
          />

          <button
            type="submit"
            style={{
              marginLeft: 8,
              padding: "10px 16px",
              borderRadius: 10,
              border: 0,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            表示
          </button>
        </form>
      </div>

      {data.error && (
        <div
          style={{
            padding: 18,
            marginBottom: 24,
            border: "1px solid rgba(255,80,80,.45)",
            borderRadius: 12,
          }}
        >
          DBエラー：{data.error}
        </div>
      )}

      <section
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          marginBottom: 28,
        }}
      >
        <Stat label="CAP GMV" value={yen(data.totals.capGmv)} />
        <Stat
          label="CAP エージェンシー収益"
          value={yen(data.totals.capRevenue)}
        />
        <Stat
          label="TAP収益"
          value={yen(data.totals.tapRevenue)}
        />
        <Stat
          label="クリエイター支払"
          value={yen(data.totals.creatorPayout)}
        />
        <Stat
          label="紹介者報酬"
          value={yen(data.totals.referralReward)}
        />
        <Stat
          label="代理店支払"
          value={yen(data.totals.agencyPayout)}
        />
        <Stat
          label="弊社残額"
          value={yen(
            data.totals.companyRevenueAfterPayouts,
          )}
        />
      </section>

      <div
        style={{
          overflowX: "auto",
          border:
            "1px solid rgba(255,255,255,.10)",
          borderRadius: 14,
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            minWidth: 1550,
          }}
        >
          <thead>
            <tr
              style={{
                background: "rgba(255,255,255,.05)",
                textAlign: "left",
              }}
            >
              <Th>クリエイター</Th>
              <Th>所属</Th>
              <Th>CAP GMV</Th>
              <Th>CAP収益</Th>

              <Th>TAP標準</Th>
              <Th>TAP広告</Th>
              <Th>TAPボーナス</Th>
              <Th>TAP合計</Th>

              <Th>CAP分配率</Th>
              <Th>クリエイター支払</Th>

              <Th>紹介者</Th>
              <Th>紹介者報酬</Th>

              <Th>代理店支払</Th>
              <Th>弊社残額</Th>
            </tr>
          </thead>

          <tbody>
            {data.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={14}
                  style={{
                    padding: 40,
                    textAlign: "center",
                    opacity: 0.55,
                  }}
                >
                  {targetMonth} の収支データはありません。
                </td>
              </tr>
            ) : (
              data.rows.map((row) => (
                <tr
                  key={row.creatorId}
                  style={{
                    borderTop:
                      "1px solid rgba(255,255,255,.08)",
                  }}
                >
                  <Td>
                    <div style={{ fontWeight: 700 }}>
                      {row.creatorName}
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        opacity: 0.55,
                        marginTop: 4,
                      }}
                    >
                      @{row.tiktokId}
                    </div>
                  </Td>

                  <Td>
                    {row.isInHouse ? (
                      <strong>自社</strong>
                    ) : (
                      row.agencyName ?? "未振り分け"
                    )}
                  </Td>

                  <Td>{yen(row.capGmv)}</Td>
                  <Td>{yen(row.capRevenue)}</Td>

                  <Td>{yen(row.tapStandardRevenue)}</Td>
                  <Td>{yen(row.tapShopAdsRevenue)}</Td>
                  <Td>{yen(row.tapBonusRevenue)}</Td>
                  <Td>{yen(row.tapRevenue)}</Td>

                  <Td>
                    {row.agencySplitRate === null ||
                    row.commissionRate === null ? (
                      <span style={{ opacity: 0.5 }}>—</span>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            whiteSpace: "nowrap",
                          }}
                        >
                          エージェンシー{" "}
                          <strong>
                            {Number(
                              row.agencySplitRate.toFixed(2),
                            )}%
                          </strong>
                        </div>

                        <div
                          style={{
                            fontSize: 12,
                            whiteSpace: "nowrap",
                            opacity: 0.7,
                          }}
                        >
                          クリエイター{" "}
                          <strong>
                            {Number(
                              row.commissionRate.toFixed(2),
                            )}%
                          </strong>
                        </div>
                      </div>
                    )}
                  </Td>

                  <Td>
                    {yen(row.creatorPayout)}
                  </Td>

                  <Td>{row.referrerName ?? "—"}</Td>

                  <Td>
                    {yen(row.referralReward)}
                  </Td>

                  <Td>{yen(row.agencyPayout)}</Td>

                  <Td>
                    <strong>
                      {yen(
                        row.companyRevenueAfterPayouts,
                      )}
                    </strong>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div
        style={{
          marginTop: 22,
          padding: 18,
          borderRadius: 12,
          background: "rgba(255,255,255,.035)",
          fontSize: 13,
          lineHeight: 1.8,
          opacity: 0.75,
        }}
      >
        <div>
          ・代理店所属：CAPのエージェンシー収益総額を
          原則そのまま代理店支払額として計算
        </div>

        <div>
          ・CAP分配率：Excelの
          「エージェンシー成果報酬分配の一部」を正として使用。
          クリエイター率は100%からエージェンシー率を差し引いて表示
        </div>

        <div>
          ・クリエイター支払：CAPの分配前収益から
          エージェンシー収益総額を差し引いた実金額を使用
        </div>

        <div>
          ・紹介者報酬：TAPの
          「アフィリエイトパートナー推定成果報酬額」
          × 5%
        </div>

        <div>
          ・TAP広告収益・TAPボーナス収益は
          紹介者報酬5%の計算元には含めません
        </div>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        padding: 18,
        borderRadius: 12,
        border:
          "1px solid rgba(255,255,255,.10)",
      }}
    >
      <div
        style={{
          fontSize: 12,
          opacity: 0.55,
          marginBottom: 7,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Th({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <th
      style={{
        padding: "14px 12px",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <td
      style={{
        padding: "14px 12px",
        fontSize: 13,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
