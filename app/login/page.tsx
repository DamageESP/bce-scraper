"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") ?? "/";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error ?? "No autorizado");
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setErr("Error de red");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-card">
      <h1>BdE → CRM</h1>
      <p>Introduce la contraseña para entrar.</p>
      <form onSubmit={submit}>
        <input
          type="password"
          placeholder="Contraseña"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
          required
        />
        {err && <div className="error">{err}</div>}
        <button type="submit" className="primary" disabled={busy || !pw}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="login-shell">
      <Suspense fallback={<div className="login-card">Cargando…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
