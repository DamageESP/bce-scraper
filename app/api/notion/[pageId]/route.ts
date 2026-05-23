import { NextResponse } from "next/server";
import { archivePage } from "@/lib/notion";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ pageId: string }> },
) {
  const { pageId } = await context.params;
  if (!pageId) {
    return NextResponse.json({ error: "pageId requerido" }, { status: 400 });
  }
  try {
    await archivePage(pageId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Notion error" },
      { status: 502 },
    );
  }
}
