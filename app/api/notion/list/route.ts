import { NextResponse } from "next/server";
import { listCrm } from "@/lib/notion";

export const runtime = "nodejs";

export async function GET() {
  try {
    const rows = await listCrm(200);
    return NextResponse.json({ rows });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Notion error" },
      { status: 502 },
    );
  }
}
