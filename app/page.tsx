"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

function activeRolesOf(hit: SearchHit): string[] {
  return (hit.roles ?? [])
    .filter((r) => !r.fechaBajaRol && r.nombreRol)
    .map((r) => r.nombreRol as string);
}

function normalizeStr(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
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
  icpScore: number | null;
  icpTier: string | null;
  resumenIa: string | null;
  enriquecido: string | null;
};

type EntityDetail = {
  idelemento: number;
  address: string | null;
  localidad: string | null;
  provincia: string | null;
  codigoPostal: string | null;
  phones: string[];
  websites: string[];
  administradores: string[];
};

const PAGE_SIZE = 20;
const DISCARDED_KEY = "bde_discarded_v1";

function loadDiscardedFromStorage(): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISCARDED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((n) => typeof n === "number"));
  } catch {
    return new Set();
  }
}

function saveDiscardedToStorage(ids: Set<number>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      DISCARDED_KEY,
      JSON.stringify(Array.from(ids)),
    );
  } catch {}
}

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
  const [enrichingIds, setEnrichingIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{
    done: number;
    total: number;
    current: string;
  } | null>(null);
  const bulkCancelRef = useRef(false);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; msg: string } | null>(
    null,
  );

  // Per-record detail enrichment (localidad lives on /api/detail only).
  const [details, setDetails] = useState<Map<number, EntityDetail>>(new Map());
  const [detailLoadingIds, setDetailLoadingIds] = useState<Set<number>>(
    new Set(),
  );
  const [detailErrors, setDetailErrors] = useState<Map<number, string>>(
    new Map(),
  );

  // Discard list (localStorage).
  const [discarded, setDiscarded] = useState<Set<number>>(new Set());
  const [showDiscarded, setShowDiscarded] = useState(false);

  // Filters.
  const [localidadFilter, setLocalidadFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDiscarded(loadDiscardedFromStorage());
  }, []);

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

  async function loadDetail(id: number) {
    if (details.has(id) || detailLoadingIds.has(id)) return;
    setDetailLoadingIds((s) => new Set(s).add(id));
    setDetailErrors((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
    try {
      const res = await fetch(`/api/detail/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setDetails((m) => {
        const next = new Map(m);
        next.set(id, {
          idelemento: id,
          address: data.address ?? null,
          localidad: data.localidad ?? null,
          provincia: data.provincia ?? null,
          codigoPostal: data.codigoPostal ?? null,
          phones: Array.isArray(data.phones) ? data.phones : [],
          websites: Array.isArray(data.websites) ? data.websites : [],
          administradores: Array.isArray(data.administradores)
            ? data.administradores
            : [],
        });
        return next;
      });
    } catch (e: any) {
      setDetailErrors((m) => {
        const next = new Map(m);
        next.set(id, e?.message ?? "Error cargando detalle");
        return next;
      });
    } finally {
      setDetailLoadingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  function toggleDiscard(id: number) {
    setDiscarded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveDiscardedToStorage(next);
      return next;
    });
  }

  function clearAllDiscarded() {
    if (
      !confirm(
        `¿Borrar los ${discarded.size} descarte(s) guardados en este navegador?`,
      )
    )
      return;
    const empty = new Set<number>();
    setDiscarded(empty);
    saveDiscardedToStorage(empty);
  }

  function toggleRoleFilter(name: string) {
    setRoleFilter((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function clearFilters() {
    setLocalidadFilter("");
    setRoleFilter(new Set());
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

  // Warn before closing the tab while a bulk enrichment is running.
  useEffect(() => {
    if (!bulkProgress) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [bulkProgress]);

  const enrichOne = useCallback(
    async (row: CrmRow): Promise<boolean> => {
      setEnrichingIds((s) => new Set(s).add(row.id));
      try {
        const res = await fetch(`/api/enrich/${row.id}`, { method: "POST" });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          icp?: { tier: string; score: number; nota: string | null };
          confianza?: string;
          error?: string;
        };
        if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const icp = data.icp!;
        showToast(
          "ok",
          `${row.nombre || row.empresa}: ${icp.tier} · ${icp.score}/100 (confianza ${data.confianza ?? "?"})${icp.nota ? ` · ${icp.nota}` : ""}`,
        );
        return true;
      } catch (e: any) {
        showToast("error", `${row.nombre || row.empresa}: ${e?.message ?? "Error"}`);
        return false;
      } finally {
        setEnrichingIds((s) => {
          const next = new Set(s);
          next.delete(row.id);
          return next;
        });
      }
    },
    [showToast],
  );

  async function enrichRow(row: CrmRow) {
    if (enrichingIds.has(row.id) || bulkProgress) return;
    await enrichOne(row);
    refreshCrm();
  }

  async function enrichPending() {
    if (bulkProgress) return;
    const pending = (crm ?? []).filter((r) => !r.icpTier);
    if (pending.length === 0) return;
    if (
      !confirm(
        `¿Enriquecer ${pending.length} lead(s) pendientes? Tarda 1-3 min por lead y consume API de Anthropic.`,
      )
    )
      return;
    bulkCancelRef.current = false;
    let ok = 0;
    // Sequential on purpose: each lead gets its own serverless invocation and
    // the loop naturally throttles Notion + Anthropic.
    for (let i = 0; i < pending.length; i++) {
      if (bulkCancelRef.current) break;
      const row = pending[i];
      setBulkProgress({
        done: i,
        total: pending.length,
        current: row.nombre || row.empresa,
      });
      if (await enrichOne(row)) ok++;
    }
    setBulkProgress(null);
    showToast(
      bulkCancelRef.current ? "ok" : ok > 0 ? "ok" : "error",
      bulkCancelRef.current
        ? `Bulk cancelado: ${ok} enriquecidos (los completados se conservan).`
        : `Bulk terminado: ${ok}/${pending.length} enriquecidos.`,
    );
    refreshCrm();
  }

  async function logout() {
    document.cookie =
      "bde_crm_session=; Max-Age=0; Path=/; SameSite=Lax; Secure";
    location.href = "/login";
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Roles present in the current page (active ones only), for the role chips.
  const availableRoles = useMemo(() => {
    const set = new Set<string>();
    for (const hit of results ?? []) {
      for (const r of activeRolesOf(hit)) set.add(r);
    }
    return Array.from(set).sort();
  }, [results]);

  const locFilterNorm = normalizeStr(localidadFilter.trim());

  const filteredResults = useMemo(() => {
    if (!results) return null;
    return results.filter((hit) => {
      if (!showDiscarded && discarded.has(hit.idelemento)) return false;
      if (roleFilter.size > 0) {
        const active = activeRolesOf(hit);
        if (!active.some((r) => roleFilter.has(r))) return false;
      }
      if (locFilterNorm) {
        const det = details.get(hit.idelemento);
        if (!det) return true; // keep unenriched so user can decide to load
        const haystack = normalizeStr(
          [det.localidad, det.provincia, det.codigoPostal, det.address]
            .filter(Boolean)
            .join(" "),
        );
        if (!haystack.includes(locFilterNorm)) return false;
      }
      return true;
    });
  }, [results, showDiscarded, discarded, roleFilter, locFilterNorm, details]);

  const discardedCountInResults = useMemo(() => {
    if (!results) return 0;
    return results.filter((h) => discarded.has(h.idelemento)).length;
  }, [results, discarded]);

  const hiddenByFilters =
    results && filteredResults
      ? results.length - filteredResults.length - (showDiscarded ? 0 : discardedCountInResults)
      : 0;

  const anyFilterActive =
    localidadFilter.trim().length > 0 || roleFilter.size > 0;

  const pendingEnrichCount = (crm ?? []).filter((r) => !r.icpTier).length;

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

        {results !== null && results.length > 0 && (
          <div className="filters">
            <div className="filter-row">
              <label className="filter-label" htmlFor="localidad-filter">
                Localidad / provincia
              </label>
              <input
                id="localidad-filter"
                type="search"
                placeholder='Ej: "Málaga"'
                value={localidadFilter}
                onChange={(e) => setLocalidadFilter(e.target.value)}
              />
              <div className="filter-hint">
                Filtra entre las fichas con detalle cargado. Las que no tengan
                detalle siguen visibles para que las cargues si quieres.
              </div>
            </div>

            {availableRoles.length > 0 && (
              <div className="filter-row">
                <div className="filter-label">Actividad (rol)</div>
                <div className="role-chips">
                  {availableRoles.map((r) => {
                    const active = roleFilter.has(r);
                    return (
                      <button
                        type="button"
                        key={r}
                        className={active ? "chip chip-active" : "chip"}
                        onClick={() => toggleRoleFilter(r)}
                        title={active ? "Quitar filtro" : "Filtrar por este rol"}
                      >
                        {r}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="filter-row filter-row-inline">
              {anyFilterActive && (
                <button type="button" onClick={clearFilters}>
                  Limpiar filtros
                </button>
              )}
              <label className="discard-toggle">
                <input
                  type="checkbox"
                  checked={showDiscarded}
                  onChange={(e) => setShowDiscarded(e.target.checked)}
                />
                Mostrar descartados
                {discardedCountInResults > 0 && (
                  <span className="muted"> ({discardedCountInResults} en esta página)</span>
                )}
              </label>
              {discarded.size > 0 && (
                <button
                  type="button"
                  className="danger"
                  onClick={clearAllDiscarded}
                  title="Borra todos los descartes guardados en este navegador"
                >
                  Borrar descartes ({discarded.size})
                </button>
              )}
            </div>
          </div>
        )}

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
                {filteredResults && filteredResults.length !== results.length && (
                  <>
                    {" · "}
                    {filteredResults.length} visibles tras filtros
                  </>
                )}
              </div>
            </div>
            {filteredResults && filteredResults.length === 0 ? (
              <div className="empty">
                Ningún resultado pasa los filtros en esta página.
                {hiddenByFilters > 0 && (
                  <>
                    {" "}
                    <button type="button" onClick={clearFilters}>
                      Limpiar filtros
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="results">
                {(filteredResults ?? []).map((hit) => {
                  const nif =
                    hit.documentos?.find((d) => d.tipoDocumento === "NIF")
                      ?.numeroDocumento ?? null;
                  const already = inCrmByIdelemento.has(hit.idelemento);
                  const busy = busyIds.has(hit.idelemento);
                  const inactive = isHitInactive(hit);
                  const bajaDate = inactive ? latestBaja(hit) : null;
                  const isDiscarded = discarded.has(hit.idelemento);
                  const detail = details.get(hit.idelemento);
                  const detailLoading = detailLoadingIds.has(hit.idelemento);
                  const detailError = detailErrors.get(hit.idelemento);
                  const className = [
                    "result",
                    inactive ? "inactive" : null,
                    isDiscarded ? "discarded" : null,
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div className={className} key={hit.idelemento}>
                      <div>
                        <div className="name">
                          {hit.nombre}
                          {inactive && (
                            <span className="tag baja" title={`Dado de baja${bajaDate ? " el " + bajaDate : ""}`}>
                              ⛔ Baja{bajaDate ? ` · ${bajaDate}` : ""}
                            </span>
                          )}
                          {isDiscarded && (
                            <span className="tag muted" style={{ marginLeft: 8 }}>
                              Descartado
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
                        {detail && (
                          <div className="detail-block">
                            {detail.localidad || detail.provincia ? (
                              <div className="detail-line">
                                <strong>📍 </strong>
                                {[detail.localidad, detail.provincia]
                                  .filter(Boolean)
                                  .join(", ")}
                                {detail.codigoPostal ? ` (${detail.codigoPostal})` : ""}
                              </div>
                            ) : null}
                            {detail.address && (
                              <div className="detail-line muted">
                                {detail.address}
                              </div>
                            )}
                            {detail.phones.length > 0 && (
                              <div className="detail-line">
                                📞 {detail.phones.join(" · ")}
                              </div>
                            )}
                            {detail.websites.length > 0 && (
                              <div className="detail-line">
                                {detail.websites.map((w, i) => (
                                  <a
                                    key={i}
                                    href={w.startsWith("http") ? w : `https://${w}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ marginRight: 8 }}
                                  >
                                    {w}
                                  </a>
                                ))}
                              </div>
                            )}
                            {detail.administradores.length > 0 && (
                              <div className="detail-line muted">
                                Admin: {detail.administradores.slice(0, 3).join(", ")}
                                {detail.administradores.length > 3
                                  ? ` (+${detail.administradores.length - 3})`
                                  : ""}
                              </div>
                            )}
                            {!detail.localidad &&
                              !detail.provincia &&
                              !detail.address && (
                                <div className="detail-line muted">
                                  Sin dirección registrada.
                                </div>
                              )}
                          </div>
                        )}
                        {detailError && (
                          <div className="error" style={{ marginTop: 6 }}>
                            {detailError}{" "}
                            <button
                              type="button"
                              onClick={() => loadDetail(hit.idelemento)}
                            >
                              Reintentar
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="result-actions">
                        {!detail && !detailError && (
                          <button
                            type="button"
                            onClick={() => loadDetail(hit.idelemento)}
                            disabled={detailLoading}
                            title="Carga la dirección, teléfonos y webs desde BdE"
                          >
                            {detailLoading ? (
                              <>
                                <span className="spinner" /> Cargando
                              </>
                            ) : (
                              "📍 Cargar detalle"
                            )}
                          </button>
                        )}
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
                        <button
                          type="button"
                          className={isDiscarded ? "" : "danger"}
                          onClick={() => toggleDiscard(hit.idelemento)}
                          title={
                            isDiscarded
                              ? "Quitar de descartados"
                              : "Marcar como descartado (no se mostrará en futuras búsquedas en este navegador)"
                          }
                        >
                          {isDiscarded ? "Restaurar" : "Descartar"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
          <div style={{ display: "flex", gap: 8 }}>
            {pendingEnrichCount > 0 && !bulkProgress && (
              <button onClick={enrichPending} title="Enriquece secuencialmente todos los leads sin ICP Tier">
                ✨ Enriquecer pendientes ({pendingEnrichCount})
              </button>
            )}
            {bulkProgress && (
              <button className="danger" onClick={() => (bulkCancelRef.current = true)}>
                Cancelar bulk
              </button>
            )}
            <button onClick={refreshCrm} disabled={crmLoading}>
              {crmLoading ? "Cargando…" : "Refrescar"}
            </button>
          </div>
        </div>
        {bulkProgress && (
          <div className="ok">
            Enriqueciendo {bulkProgress.done + 1}/{bulkProgress.total}:{" "}
            {bulkProgress.current}…{" "}
            <span className="spinner" />
          </div>
        )}
        {crmError && <div className="error">{crmError}</div>}
        {crm === null ? (
          <div className="empty">Cargando…</div>
        ) : crm.length === 0 ? (
          <div className="empty">Sin filas en el CRM.</div>
        ) : (
          <div className="results">
            {crm.map((row) => {
              const enriching = enrichingIds.has(row.id);
              return (
                <div className="crm-row" key={row.id}>
                  <div>
                    <div className="name">
                      <a href={row.url} target="_blank" rel="noreferrer">
                        {row.nombre || "(sin nombre)"}
                      </a>
                      {row.icpTier && (
                        <span
                          className={`tag tier tier-${row.icpTier.toLowerCase()}`}
                          title={
                            row.enriquecido
                              ? `Enriquecido el ${row.enriquecido}`
                              : undefined
                          }
                        >
                          {row.icpTier}
                          {row.icpScore != null ? ` · ${row.icpScore}` : ""}
                        </span>
                      )}
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
                    {row.resumenIa && (
                      <div className="meta muted">{row.resumenIa}</div>
                    )}
                  </div>
                  <div className="result-actions">
                    <button
                      disabled={enriching || !!bulkProgress}
                      onClick={() => enrichRow(row)}
                      title="Investiga la empresa con IA y escribe el ICP + call prep en Notion (1-3 min)"
                    >
                      {enriching ? (
                        <>
                          <span className="spinner" /> Enriqueciendo
                        </>
                      ) : row.icpTier ? (
                        "Re-enriquecer"
                      ) : (
                        "✨ Enriquecer"
                      )}
                    </button>
                    <button
                      className="danger"
                      disabled={deletingIds.has(row.id)}
                      onClick={() => removeFromCrm(row)}
                    >
                      {deletingIds.has(row.id) ? "Eliminando…" : "Eliminar"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
