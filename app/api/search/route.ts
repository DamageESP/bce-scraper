import { NextResponse } from "next/server";
import { searchBde } from "@/lib/bde";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Math.min(100, Number(url.searchParams.get("page_size") ?? "50"));

  if (q.length < 1) {
    return NextResponse.json(
      { error: "Introduce un término de búsqueda" },
      { status: 400 },
    );
  }
  if (q.length > 50) {
    return NextResponse.json({ error: "Máximo 50 caracteres" }, { status: 400 });
  }
  if (!/^([0-9A-Za-zÀ-ÖØ-öø-ÿ]+[ ]*)*$/.test(q)) {
    return NextResponse.json(
      { error: "Solo se permiten letras, números y espacios" },
      { status: 400 },
    );
  }

  try {
    const data = await searchBde(q, page, pageSize);
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "BdE error" },
      { status: 502 },
    );
  }
}
