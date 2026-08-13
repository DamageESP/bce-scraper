// Helpers to talk to the public Banco de España "Registro de Entidades" API.
// The same endpoints used by https://app.bde.es/rbe_spa/home.

const BDE_BASE = "https://app.bde.es/rbe_out";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const COMMON_HEADERS: HeadersInit = {
  "User-Agent": UA,
  Referer: "https://app.bde.es/rbe_spa/home",
  Origin: "https://app.bde.es",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "es-ES,es;q=0.9",
};

async function bdeFetch(path: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BDE_BASE}${path}`, {
        headers: COMMON_HEADERS,
        cache: "no-store",
      });
      if (res.status === 500 || res.status === 502 || res.status === 503) {
        lastErr = new Error(`BdE ${res.status}`);
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`BdE ${res.status}: ${await res.text()}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  throw lastErr ?? new Error("BdE request failed");
}

export type BdeSearchHit = {
  idelemento: number;
  nombre: string;
  tipoPersona?: string;
  codigoBE?: string;
  nombreComerciales?: string[];
  documentos?: { tipoDocumento: string; numeroDocumento: string }[];
  roles?: { nombreRol?: string; fechaAltaRol?: string; fechaBajaRol?: string }[];
};

/**
 * An entity is "inactive" when every one of its registered roles has a
 * fechaBajaRol set (i.e. it's no longer operating in any capacity).
 * Returns null if there are no roles at all (can't tell).
 */
export function isInactive(
  roles:
    | { fechaBajaRol?: string }[]
    | undefined,
): boolean | null {
  if (!roles || roles.length === 0) return null;
  return roles.every((r) => Boolean(r.fechaBajaRol));
}

/** Most recent fechaBajaRol across all roles, ISO date string or null. */
export function latestBajaRol(
  roles: { fechaBajaRol?: string }[] | undefined,
): string | null {
  if (!roles || roles.length === 0) return null;
  const dates = roles
    .map((r) => r.fechaBajaRol)
    .filter(Boolean) as string[];
  if (dates.length === 0) return null;
  return dates.sort().reverse()[0];
}

export type BdeSearchResponse = {
  numResultados: number;
  elementos: BdeSearchHit[];
};

export async function searchBde(
  q: string,
  page = 1,
  pageSize = 50,
): Promise<BdeSearchResponse> {
  const params = new URLSearchParams({
    q,
    sort: "nombre",
    lang: "ES",
    sort_order: "ASC",
    page: String(page),
    page_size: String(pageSize),
  });
  return bdeFetch(`/elementos?${params.toString()}`);
}

export type BdeRole = {
  nombreRol?: string;
  telefonos?: string[];
  paginaWeb?: string;
  nombreComerciales?: string[];
  paisOrigen?: string;
  fechaAltaRol?: string;
  fechaBajaRol?: string;
};

export type BdeDetail = {
  idelemento: number;
  nombre: string;
  tipoPersona?: string;
  codigoBE?: string;
  documentos?: { tipoDocumento: string; numeroDocumento: string }[];
  direccion?: {
    tipovia?: string;
    nombreVia?: string;
    numeroVia?: string;
    localidad?: string;
    provincia?: string;
    codigoPostal?: string;
    pais?: string;
  };
  administradores?: { nombreAdministrador?: string }[];
  roles?: BdeRole[];
};

export async function fetchBdeDetail(id: number): Promise<BdeDetail> {
  return bdeFetch(`/elementos/${id}?lang=ES`);
}

/**
 * BdE stores `paginaWeb` as free text: "www.foo.es", "http://foo.es",
 * "foo.es bar.es", "no tiene"… Turn one entry into an absolute URL that
 * Notion accepts (url property / bookmark block), or null when it doesn't
 * look like a web address at all.
 */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  // Multiple sites are sometimes crammed into one field; keep the first.
  const s = (raw ?? "").trim().split(/[\s;|]+/)[0]?.replace(/[.,]+$/, "") ?? "";
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  // Guard against non-addresses that still parse: bare words ("no", "-"),
  // and e-mails, which look like userinfo ("correo@foo.es" → correo@ + foo.es).
  if (u.username || u.password) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(u.hostname)) return null;
  const url = u.toString();
  return u.pathname === "/" && !u.search && !u.hash ? url.slice(0, -1) : url;
}

export type NormalizedEntity = {
  idelemento: number;
  nombre: string;
  nombresComerciales: string[];
  nif: string | null;
  lei: string | null;
  codigoBE: string | null;
  tipoPersona: string | null;
  roles: string[];
  activeRoles: string[];
  inactiveRoles: { nombreRol: string; fechaBajaRol: string }[];
  inactive: boolean | null;
  bajaDate: string | null;
  /** As registered at BdE, may lack a scheme. Shown in the UI as-is. */
  websites: string[];
  /** `websites` normalised to absolute URLs, unusable entries dropped. */
  websiteUrls: string[];
  primaryWebsite: string | null;
  phones: string[];
  primaryPhone: string | null;
  administradores: string[];
  address: string | null;
  localidad: string | null;
  provincia: string | null;
  codigoPostal: string | null;
  detalleUrl: string;
};

export function normalizeDetail(d: BdeDetail): NormalizedEntity {
  const addr = d.direccion ?? {};
  const street = [addr.tipovia, addr.nombreVia, addr.numeroVia]
    .filter(Boolean)
    .join(" ");
  const cityParts = [
    addr.codigoPostal,
    addr.localidad,
    addr.provincia,
    addr.pais,
  ].filter(Boolean);
  const address = [street, cityParts.join(", ")].filter(Boolean).join(", ");

  const docs = d.documentos ?? [];
  const nif =
    docs.find((x) => x.tipoDocumento === "NIF")?.numeroDocumento ?? null;
  const lei =
    docs.find((x) => x.tipoDocumento === "LEI")?.numeroDocumento ?? null;

  const rolesRaw = d.roles ?? [];
  const roles = Array.from(
    new Set(rolesRaw.map((r) => r.nombreRol).filter(Boolean) as string[]),
  ).sort();
  const activeRoles = Array.from(
    new Set(
      rolesRaw
        .filter((r) => !r.fechaBajaRol && r.nombreRol)
        .map((r) => r.nombreRol) as string[],
    ),
  ).sort();
  const inactiveRoles = rolesRaw
    .filter((r) => r.fechaBajaRol && r.nombreRol)
    .map((r) => ({
      nombreRol: r.nombreRol as string,
      fechaBajaRol: r.fechaBajaRol as string,
    }));

  const phones: string[] = [];
  const websites: string[] = [];
  const nombres_com: string[] = [];
  for (const r of rolesRaw) {
    for (const t of r.telefonos ?? []) {
      if (t && !phones.includes(t)) phones.push(t);
    }
    if (r.paginaWeb && !websites.includes(r.paginaWeb)) websites.push(r.paginaWeb);
    for (const c of r.nombreComerciales ?? []) {
      if (c && !nombres_com.includes(c)) nombres_com.push(c);
    }
  }
  const administradores = (d.administradores ?? [])
    .map((a) => a.nombreAdministrador)
    .filter(Boolean) as string[];

  const websiteUrls: string[] = [];
  for (const w of websites) {
    const u = normalizeWebsite(w);
    if (u && !websiteUrls.includes(u)) websiteUrls.push(u);
  }

  return {
    idelemento: d.idelemento,
    nombre: (d.nombre ?? "").trim(),
    nombresComerciales: nombres_com.map((c) => c.trim()),
    nif,
    lei,
    codigoBE: d.codigoBE ?? null,
    tipoPersona: d.tipoPersona ?? null,
    roles,
    activeRoles,
    inactiveRoles,
    inactive: isInactive(rolesRaw),
    bajaDate: latestBajaRol(rolesRaw),
    websites,
    websiteUrls,
    primaryWebsite: websiteUrls[0] ?? null,
    phones,
    primaryPhone: phones[0] ?? null,
    administradores,
    address: address || null,
    localidad: addr.localidad ?? null,
    provincia: addr.provincia ?? null,
    codigoPostal: addr.codigoPostal ?? null,
    detalleUrl: `https://app.bde.es/rbe_spa/detalle/${d.idelemento}`,
  };
}
