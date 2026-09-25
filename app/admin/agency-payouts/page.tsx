import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

import { fetchAgencyMonthlyPayouts } from "@/lib/db/agency-monthly-payout-queries";

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

export default async function AgencyPayoutsPage({
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

  const data = await fetchAgencyMonthlyPayouts(
    supabase,
    targetMonth,
  );

  return (
    <main
      style={{
        padding: "32px",
        maxWidth: "1500px",
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
            AGENCY PAYOUT
          </div>

          <h1
            style={{
              fontSize: 30,
              fontWeight: 800,
              margin: 0,
            }}
          >
            代理店支払一覧
          </h1>

          <p
            style={{
              marginTop: 10,
              opacity: 0.7,
              lineHeight: 1.7,
            }}
          >
            月別に確定した代理店所属をもとに、
            CAP収益から代理店への支払額を集計します。
            TAP収益は代理店への支払対象に含みません。
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

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 24,
        }}
      >
        <Link
          href={`/admin/monthly-agency-assignments?month=${targetMonth}`}
          style={{
            padding: "9px 14px",
            borderRadius: 9,
            border: "1px solid rgba(255,255,255,.12)",
            textDecoration: "none",
            color: "inherit",
            fontSize: 13,
          }}
        >
          月別支払先を確認
        </Link>

        <Link
          href={`/admin/monthly-finance?month=${targetMonth}`}
          style={{
            padding: "9px 14px",
            borderRadius: 9,
            border: "1px solid rgba(255,255,255,.12)",
            textDecoration: "none",
            color: "inherit",
            fontSize: 13,
          }}
        >
          クリエイター月次収支
        </Link>
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

      {data.unconfirmedCreatorCount > 0 && (
        <div
          style={{
            padding: 18,
            marginBottom: 24,
            border: "1px solid rgba(255,190,70,.4)",
            background: "rgba(255,190,70,.06)",
            borderRadius: 12,
          }}
        >
          <div
            style={{
              fontWeight: 800,
              marginBottom: 6,
            }}
          >
            支払先未確定：{data.unconfirmedCreatorCount}人
          </div>

          <div
            style={{
              fontSize: 13,
              opacity: 0.75,
              lineHeight: 1.6,
            }}
          >
            月別支払先が未確定のクリエイターは、
            代理店支払額には含まれていません。
            支払確定前に月別支払先を確認してください。
          </div>
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
        <Stat
          label="支払対象代理店"
          value={`${data.totals.agencyCount}社`}
        />

        <Stat
          label="対象クリエイター"
          value={`${data.totals.creatorCount}人`}
        />

        <Stat
          label="CAP支払額"
          value={yen(data.totals.capPayout)}
        />

        <Stat
          label="TAP支払額"
          value={yen(data.totals.tapPayout)}
        />

        <Stat
          label="代理店支払合計"
          value={yen(data.totals.totalPayout)}
          strong
        />
      </section>

      <div
        style={{
          overflowX: "auto",
          border: "1px solid rgba(255,255,255,.10)",
          borderRadius: 14,
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            minWidth: 900,
          }}
        >
          <thead>
            <tr
              style={{
                background: "rgba(255,255,255,.05)",
                textAlign: "left",
              }}
            >
              <Th>代理店</Th>
              <Th>対象クリエイター</Th>
              <Th>CAP支払額</Th>
              <Th>TAP支払額</Th>
              <Th>合計支払額</Th>
            </tr>
          </thead>

          <tbody>
            {data.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    padding: 40,
                    textAlign: "center",
                    opacity: 0.55,
                  }}
                >
                  {targetMonth} の代理店支払データはありません。
                </td>
              </tr>
            ) : (
              data.rows.map((row) => (
                <tr
                  key={row.agencyId}
                  style={{
                    borderTop:
                      "1px solid rgba(255,255,255,.08)",
                  }}
                >
                  <Td>
                    <strong>{row.agencyName}</strong>
                  </Td>

                  <Td>
                    {row.creatorCount.toLocaleString("ja-JP")}人
                  </Td>

                  <Td>{yen(row.capPayout)}</Td>

                  <Td>
                    <div>{yen(row.tapPayout)}</div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 11,
                        opacity: 0.5,
                      }}
                    >
                      代理店支払対象外
                    </div>
                  </Td>

                  <Td>
                    <strong
                      style={{
                        fontSize: 16,
                      }}
                    >
                      {yen(row.totalPayout)}
                    </strong>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      style={{
        padding: 18,
        borderRadius: 12,
        border: strong
          ? "1px solid rgba(70,220,160,.35)"
          : "1px solid rgba(255,255,255,.10)",
        background: strong
          ? "rgba(70,220,160,.06)"
          : "rgba(255,255,255,.025)",
      }}
    >
      <div
        style={{
          fontSize: 12,
          opacity: 0.55,
          marginBottom: 8,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: strong ? 23 : 20,
          fontWeight: strong ? 800 : 700,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "13px 16px",
        fontSize: 12,
        whiteSpace: "nowrap",
        opacity: 0.65,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "16px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
