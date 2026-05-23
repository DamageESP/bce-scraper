import { NextResponse } from "next/server";
import {
  COOKIE_NAME,
  SEVEN_DAYS,
  buildSessionCookieValue,
  checkPassword,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { password?: string } = {};
  try {
    body = await req.json();
  } catch {}
  if (!body.password || !checkPassword(body.password)) {
    return NextResponse.json({ error: "Contraseña incorrecta" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: COOKIE_NAME,
    value: await buildSessionCookieValue(),
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SEVEN_DAYS,
  });
  return res;
}
