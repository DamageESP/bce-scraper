import { NextResponse } from "next/server";
import { fetchBdeDetail, normalizeDetail } from "@/lib/bde";
import { createProspect, findExistingByIdelemento } from "@/lib/notion";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { idelemento?: number } = {};
  try {
    body = await req.json();
  } catch {}
  const id = Number(body.idelemento);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "idelemento inválido" }, { status: 400 });
  }

  try {
    const existing = await findExistingByIdelemento(id);
    if (existing) {
      return NextResponse.json({
        ok: true,
        existed: true,
        page: existing,
      });
    }
    const detail = await fetchBdeDetail(id);
    const normalized = normalizeDetail(detail);
    const created = await createProspect(normalized);
    return NextResponse.json({
      ok: true,
      existed: false,
      page: {
        id: created.id,
        url: created.url,
        nombre: normalized.nombre,
        telefono: normalized.primaryPhone,
        web: normalized.primaryWebsite,
        idelemento: normalized.idelemento,
      },
      entity: normalized,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Error" },
      { status: 502 },
    );
  }
}
