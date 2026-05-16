import { runTikTokOrdersSync } from "@/lib/orders/run-tiktok-orders-sync";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.TIKTOK_ORDERS_SYNC_CRON_SECRET?.trim();
  const authHeader = request.headers.get("authorization")?.trim();

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createServiceRoleClient();
    const { result } = await runTikTokOrdersSync(supabase, {
      syncType: "tiktok_orders_cron",
    });

    return NextResponse.json({
      ok: !(result.errorMessage && result.successCount === 0),
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "同期に失敗しました",
      },
      { status: 500 },
    );
  }
}
