import { NextResponse } from "next/server";
import { fetchBdeDetail, normalizeDetail } from "@/lib/bde";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum) || idNum <= 0) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }
  try {
    const detail = await fetchBdeDetail(idNum);
    return NextResponse.json(normalizeDetail(detail));
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "BdE error" },
      { status: 502 },
    );
  }
}
