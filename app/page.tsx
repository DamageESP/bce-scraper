"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SearchHit = {
  idelemento: number;
  nombre: string;
  tipoPersona?: string;
  codigoBE?: string;
  documentos?: { tipoDocumento: string; numeroDocumento: string }[];
  roles?: { nombreRol?: string; fechaBajaRol?: string }[];
};

function isHitInactive(hit: SearchHit): boolean {
  const roles = hit.roles ?? [];
  if (roles.length === 0) return false;
  return roles.every((r) => Boolean(r.fechaBajaRol));
}

function latestBaja(hit: SearchHit): string | null {
  const dates = (hit.roles ?? [])
    .map((r) => r.fechaBajaRol)
    .filter(Boolean) as string[];
  if (dates.length === 0) return null;
  return dates.sort().reverse()[0];
}

type SearchResponse = {
  numResultados: number;
  elementos: SearchHit[];
  error?: string;
};

type CrmRow = {
  id: string;
  nombre: string;
  empresa: string;
  estado: string | null;
  telefono: string | null;
  url: string;
  idelemento: number | null;
};

const PAGE_SIZE = 20;

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [crm, setCrm] = useState<CrmRow[] | null>(null);
  const [crmLoading, setCrmLoading] = useState(false);
  const [crmError, setCrmError] = useState<string | null>(null);

  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ kind: "ok" | "error"; msg: string } | null>(
    null,
  );

  const showToast = useCallback((kind: "ok" | "error", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshCrm = useCallback(async () => {
    setCrmLoading(true);
    setCrmError(null);
    try {
      const res = await fetch("/api/notion/list", { cache: "no-store" });
      const data = (await res.json()) as { rows?: CrmRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCrm(data.rows ?? []);
    } catch (e: any) {
      setCrmError(e?.message ?? "Error");
    } finally {
      setCrmLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCrm();
  }, [refreshCrm]);

  const inCrmByIdelemento = useMemo(() => {
    const set = new Set<number>();
    for (const row of crm ?? []) {
      if (row.idelemento != null) set.add(row.idelemento);
    }
    return set;
  }, [crm]);

  const runSearch = useCallback(
    async (q: string, p: number) => {
      if (!q.trim()) return;
      setSearching(true);
      setSearchError(null);
      try {
        const params = new URLSearchParams({
          q: q.trim(),
          page: String(p),
          page_size: String(PAGE_SIZE),
        });
        const res = await fetch(`/api/search?${params.toString()}`, {
          cache: "no-store",
        });
        const data = (await res.json()) as SearchResponse;
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setResults(data.elementos ?? []);
        setTotal(data.numResultados ?? 0);
      } catch (e: any) {
        setSearchError(e?.message ?? "Error");
        setResults(null);
      } finally {
        setSearching(false);
      }
    },
    [],
  );

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setCommittedQuery(query);
    runSearch(query, 1);
  }

  function goPage(p: number) {
    setPage(p);
    runSearch(committedQuery, p);
  }

  async function addToCrm(hit: SearchHit) {
    if (busyIds.has(hit.idelemento)) return;
    setBusyIds((s) => new Set(s).add(hit.idelemento));
    try {
      const res = await fetch("/api/notion/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idelemento: hit.idelemento }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        existed?: boolean;
        page?: any;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.existed) {
        showToast("ok", `Ya existía en el CRM: ${hit.nombre}`);
      } else {
        showToast("ok", `Añadido al CRM: ${hit.nombre}`);
      }
      refreshCrm();
    } catch (e: any) {
      showToast("error", e?.message ?? "Error añadiendo a Notion");
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(hit.idelemento);
        return next;
      });
    }
  }

  async function removeFromCrm(row: CrmRow) {
    if (deletingIds.has(row.id)) return;
    if (
      !confirm(
        `¿Eliminar "${row.nombre || row.empresa}" del CRM? (se mueve a papelera de Notion)`,
      )
    )
      return;
    setDeletingIds((s) => new Set(s).add(row.id));
    try {
      const res = await fetch(`/api/notion/${row.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      showToast("ok", `Eliminado: ${row.nombre || row.empresa}`);
      refreshCrm();
    } catch (e: any) {
      showToast("error", e?.message ?? "Error eliminando");
    } finally {
      setDeletingIds((s) => {
        const next = new Set(s);
        next.delete(row.id);
        return next;
      });
    }
  }

  async function logout() {
    document.cookie =
      "bde_crm_session=; Max-Age=0; Path=/; SameSite=Lax; Secure";
    location.href = "/login";
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="shell">
      <div className="header">
        <div>
          <h1>BdE → CRM</h1>
          <div className="subtitle">
            Buscar entidades del Banco de España y añadirlas como Prospecto.
          </div>
        </div>
        <button onClick={logout}>Salir</button>
      </div>

      <section className="card">
        <h2>Buscar en BdE</h2>
        <form className="search-form" onSubmit={submitSearch}>
          <input
            type="search"
            placeholder='Ej: "encuentra tu hogar", "hipoteca", "banco"…'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button type="submit" className="primary" disabled={searching || !query.trim()}>
            {searching ? "Buscando…" : "Buscar"}
          </button>
        </form>

        {toast && (
          <div className={toast.kind === "ok" ? "ok" : "error"}>{toast.msg}</div>
        )}
        {searchError && <div className="error">{searchError}</div>}

        {results === null ? (
          <div className="empty">Sin búsqueda todavía.</div>
        ) : results.length === 0 ? (
          <div className="empty">Sin resultados.</div>
        ) : (
          <>
            <div className="toolbar">
              <div className="muted">
                {total.toLocaleString("es-ES")} resultado
                {total === 1 ? "" : "s"} para "{committedQuery}"
              </div>
            </div>
            <div className="results">
              {results.map((hit) => {
                const nif =
                  hit.documentos?.find((d) => d.tipoDocumento === "NIF")
                    ?.numeroDocumento ?? null;
                const already = inCrmByIdelemento.has(hit.idelemento);
                const busy = busyIds.has(hit.idelemento);
                const inactive = isHitInactive(hit);
                const bajaDate = inactive ? latestBaja(hit) : null;
                return (
                  <div
                    className={inactive ? "result inactive" : "result"}
                    key={hit.idelemento}
                  >
                    <div>
                      <div className="name">
                        {hit.nombre}
                        {inactive && (
                          <span className="tag baja" title={`Dado de baja${bajaDate ? " el " + bajaDate : ""}`}>
                            ⛔ Baja{bajaDate ? ` · ${bajaDate}` : ""}
                          </span>
                        )}
                      </div>
                      <div className="meta">
                        {hit.tipoPersona === "J"
                          ? "Empresa"
                          : hit.tipoPersona === "F"
                            ? "Persona física"
                            : "—"}
                        {nif ? ` · NIF ${nif}` : ""}
                        {hit.codigoBE ? ` · BdE ${hit.codigoBE}` : ""}
                        {" · "}
                        <a
                          href={`https://app.bde.es/rbe_spa/detalle/${hit.idelemento}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ver ficha
                        </a>
                      </div>
                      <div className="roles">
                        {(hit.roles ?? []).map((r, i) =>
                          r.nombreRol ? (
                            <span
                              className={
                                r.fechaBajaRol ? "tag muted strike" : "tag"
                              }
                              key={i}
                              title={
                                r.fechaBajaRol
                                  ? `Baja: ${r.fechaBajaRol}`
                                  : undefined
                              }
                            >
                              {r.nombreRol}
                            </span>
                          ) : null,
                        )}
                      </div>
                    </div>
                    <div>
                      <button
                        className="primary"
                        disabled={busy || already}
                        onClick={() => addToCrm(hit)}
                        title={
                          inactive
                            ? "Esta entidad ya no opera; aún se puede añadir como referencia"
                            : undefined
                        }
                      >
                        {busy ? (
                          <>
                            <span className="spinner" /> Añadiendo
                          </>
                        ) : already ? (
                          "Ya en CRM"
                        ) : inactive ? (
                          "Añadir (baja)"
                        ) : (
                          "Añadir al CRM"
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div className="pagination">
                <button
                  disabled={page <= 1 || searching}
                  onClick={() => goPage(page - 1)}
                >
                  ← Anterior
                </button>
                <span className="muted" style={{ alignSelf: "center" }}>
                  Página {page} / {totalPages}
                </span>
                <button
                  disabled={page >= totalPages || searching}
                  onClick={() => goPage(page + 1)}
                >
                  Siguiente →
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>CRM actual</h2>
          <button onClick={refreshCrm} disabled={crmLoading}>
            {crmLoading ? "Cargando…" : "Refrescar"}
          </button>
        </div>
        {crmError && <div className="error">{crmError}</div>}
        {crm === null ? (
          <div className="empty">Cargando…</div>
        ) : crm.length === 0 ? (
          <div className="empty">Sin filas en el CRM.</div>
        ) : (
          <div className="results">
            {crm.map((row) => (
              <div className="crm-row" key={row.id}>
                <div>
                  <div className="name">
                    <a href={row.url} target="_blank" rel="noreferrer">
                      {row.nombre || "(sin nombre)"}
                    </a>
                  </div>
                  <div className="meta">
                    {row.estado && (
                      <span className="tag muted" style={{ marginRight: 6 }}>
                        {row.estado}
                      </span>
                    )}
                    {row.telefono ? `📞 ${row.telefono}` : "sin teléfono"}
                    {row.idelemento ? ` · BdE#${row.idelemento}` : ""}
                  </div>
                </div>
                <div>
                  <button
                    className="danger"
                    disabled={deletingIds.has(row.id)}
                    onClick={() => removeFromCrm(row)}
                  >
                    {deletingIds.has(row.id) ? "Eliminando…" : "Eliminar"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
