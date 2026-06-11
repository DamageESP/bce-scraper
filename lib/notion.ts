// Thin Notion REST client targeting the CRM de ventas data source.

import type { NormalizedEntity } from "./bde";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const DATA_SOURCE_ID =
  process.env.NOTION_DATA_SOURCE_ID ?? "5758708d-7db9-824a-a4b8-879b6e6311eb";

function requireToken(): string {
  const t = process.env.NOTION_TOKEN;
  if (!t) throw new Error("NOTION_TOKEN env var is not set");
  return t;
}

async function notionFetch(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${NOTION_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${requireToken()}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
    if (res.status === 429 && attempt === 0) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 1;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }
}

export type CrmRow = {
  id: string;
  nombre: string;
  empresa: string;
  estado: string | null;
  email: string | null;
  telefono: string | null;
  url: string;
  idelemento: number | null;
  icpScore: number | null;
  icpTier: string | null;
  resumenIa: string | null;
  enriquecido: string | null;
};

const ID_PATTERNS = [
  /BdE#\s*(\d+)/i,
  /bde\.es\/rbe_spa\/detalle\/(\d+)/i,
  /bde\.es\/rbe_out\/elementos\/(\d+)/i,
];

export function parseIdelemento(text: string): number | null {
  if (!text) return null;
  for (const p of ID_PATTERNS) {
    const m = p.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

function plain(rt: { plain_text?: string }[] | undefined): string {
  return (rt ?? []).map((r) => r.plain_text ?? "").join("");
}

export async function listCrm(limit = 100): Promise<CrmRow[]> {
  const rows: CrmRow[] = [];
  let cursor: string | undefined;
  while (rows.length < limit) {
    const body: Record<string, unknown> = { page_size: Math.min(100, limit - rows.length) };
    if (cursor) body.start_cursor = cursor;
    const resp = await notionFetch(`/data_sources/${DATA_SOURCE_ID}/query`, {
      method: "POST",
      body,
    });
    for (const page of resp.results as any[]) {
      const props = page.properties ?? {};
      const empresa = plain(props["Empresa"]?.rich_text);
      const nombre = plain(props["Nombre"]?.title);
      const estado = props["Estado"]?.select?.name ?? null;
      const email = props["Email"]?.email ?? null;
      const telefono = props["Teléfono"]?.phone_number ?? null;
      rows.push({
        id: page.id,
        nombre,
        empresa,
        estado,
        email,
        telefono,
        url: page.url,
        idelemento: parseIdelemento(empresa) ?? parseIdelemento(nombre),
        icpScore: props["ICP Score"]?.number ?? null,
        icpTier: props["ICP Tier"]?.select?.name ?? null,
        resumenIa: plain(props["Resumen IA"]?.rich_text) || null,
        enriquecido: props["Enriquecido"]?.date?.start ?? null,
      });
    }
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  return rows;
}

function paragraph(content: string) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content } }],
    },
  };
}

function bookmark(url: string) {
  return { object: "block", type: "bookmark", bookmark: { url } };
}

function bodyBlocksFor(ent: NormalizedEntity) {
  const blocks: unknown[] = [];
  if (ent.address) blocks.push(paragraph(`Dirección: ${ent.address}`));
  for (const p of ent.phones) blocks.push(paragraph(`Teléfono: ${p}`));
  if (ent.nif) blocks.push(paragraph(`NIF: ${ent.nif}`));
  if (ent.lei) blocks.push(paragraph(`LEI: ${ent.lei}`));
  if (ent.codigoBE) blocks.push(paragraph(`Código BdE: ${ent.codigoBE}`));
  if (ent.nombresComerciales.length)
    blocks.push(paragraph(`Nombre comercial: ${ent.nombresComerciales.join(", ")}`));
  for (const r of ent.roles) blocks.push(paragraph(`Rol: ${r}`));
  if (ent.administradores.length)
    blocks.push(paragraph(`Administrador(es): ${ent.administradores.join(", ")}`));
  for (const w of ent.websites) blocks.push(bookmark(w));
  blocks.push(bookmark(ent.detalleUrl));
  return blocks;
}

export async function findExistingByIdelemento(
  idelemento: number,
): Promise<CrmRow | null> {
  // Lightweight: scan the database for the BdE# tag. The DB is small so
  // a single page of 100 results is usually enough; for larger DBs we'd
  // need a server-side filter, but the data source schema doesn't expose
  // a clean way to query rich_text contains via the public API.
  const rows = await listCrm(500);
  return rows.find((r) => r.idelemento === idelemento) ?? null;
}

export async function createProspect(ent: NormalizedEntity): Promise<{
  id: string;
  url: string;
}> {
  const properties: Record<string, unknown> = {
    Nombre: { title: [{ type: "text", text: { content: ent.nombre } }] },
    Empresa: {
      rich_text: [
        {
          type: "text",
          text: { content: `BdE#${ent.idelemento} ${ent.nombre}` },
        },
      ],
    },
    Estado: { select: { name: "Prospecto" } },
  };
  if (ent.primaryPhone) {
    properties["Teléfono"] = { phone_number: ent.primaryPhone };
  }

  const created = await notionFetch(`/pages`, {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
      properties,
      children: bodyBlocksFor(ent),
    },
  });
  return { id: created.id, url: created.url };
}

export async function archivePage(pageId: string): Promise<void> {
  await notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: { archived: true },
  });
}

// ---------------------------------------------------------------------------
// Lead enrichment: read lead context, write back ICP props + call-prep section
// ---------------------------------------------------------------------------

const CALL_PREP_MARKER = "📞 Call prep";

export type LeadContext = {
  pageId: string;
  nombre: string;
  empresa: string;
  estado: string | null;
  telefono: string | null;
  email: string | null;
  direccion: string | null;
  nif: string | null;
  codigoBde: string | null;
  roles: string[];
  administradores: string[];
  nombreComercial: string | null;
  websites: string[];
  bajaDate: string | null;
  // Derived in code:
  nombreComercialEfectivo: string;
  localidad: string | null;
  provincia: string | null;
  telefonoTipo: "movil" | "fijo" | null;
};

const LEGAL_FORM_RE =
  /[\s,.]*(S\.?\s?L\.?\s?U?\.?|S\.?\s?A\.?\s?U?\.?|S\.?\s?COOP\.?|SOCIEDAD\s+LIMITADA(\s+UNIPERSONAL)?|SOCIEDAD\s+AN[OÓ]NIMA)\s*$/i;

export function stripLegalForm(name: string): string {
  return name.replace(LEGAL_FORM_RE, "").trim();
}

/** "CALLE X 1, 29001, Marbella, MALAGA, ESPAÑA" → { localidad, provincia } */
export function parseLocalidadProvincia(address: string | null): {
  localidad: string | null;
  provincia: string | null;
} {
  if (!address) return { localidad: null, provincia: null };
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const cpIdx = parts.findIndex((p) => /^\d{5}$/.test(p));
  if (cpIdx >= 0) {
    return {
      localidad: parts[cpIdx + 1] ?? null,
      provincia: parts[cpIdx + 2] && !/ESPA[ÑN]A/i.test(parts[cpIdx + 2]) ? parts[cpIdx + 2] : null,
    };
  }
  const noCountry = parts.filter((p) => !/ESPA[ÑN]A/i.test(p));
  if (noCountry.length >= 2) {
    return {
      localidad: noCountry[noCountry.length - 2],
      provincia: noCountry[noCountry.length - 1],
    };
  }
  return { localidad: null, provincia: null };
}

export function phoneType(phone: string | null): "movil" | "fijo" | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "").replace(/^0*34/, "");
  if (!/^\d{9}$/.test(digits)) return null;
  return digits[0] === "6" || digits[0] === "7" ? "movil" : "fijo";
}

async function listAllChildren(blockId: string): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const resp = await notionFetch(`/blocks/${blockId}/children?${qs.toString()}`);
    blocks.push(...(resp.results ?? []));
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

function blockText(block: any): string {
  const data = block?.[block?.type];
  return plain(data?.rich_text);
}

function isCallPrepHeading(block: any): boolean {
  return (
    typeof block?.type === "string" &&
    block.type.startsWith("heading_") &&
    blockText(block).startsWith(CALL_PREP_MARKER)
  );
}

export async function getLeadContext(pageId: string): Promise<LeadContext> {
  const page = await notionFetch(`/pages/${pageId}`);
  const props = page.properties ?? {};
  const nombre = plain(props["Nombre"]?.title);
  const empresa = plain(props["Empresa"]?.rich_text);
  const estado = props["Estado"]?.select?.name ?? null;
  const telefono = props["Teléfono"]?.phone_number ?? null;
  const email = props["Email"]?.email ?? null;

  let direccion: string | null = null;
  let nif: string | null = null;
  let codigoBde: string | null = null;
  let nombreComercial: string | null = null;
  let bajaDate: string | null = null;
  const roles: string[] = [];
  const administradores: string[] = [];
  const websites: string[] = [];

  for (const block of await listAllChildren(pageId)) {
    // Never feed prior enrichment back into the model.
    if (isCallPrepHeading(block)) break;
    if (block.type === "bookmark") {
      const url: string = block.bookmark?.url ?? "";
      if (url && !url.includes("app.bde.es")) websites.push(url);
      continue;
    }
    const text = blockText(block).trim();
    if (!text) continue;
    const grab = (prefix: string) =>
      text.startsWith(prefix) ? text.slice(prefix.length).trim() : null;
    const dir = grab("Dirección:");
    if (dir) direccion = dir;
    const n = grab("NIF:");
    if (n) nif = n;
    const cb = grab("Código BdE:");
    if (cb) codigoBde = cb;
    const nc = grab("Nombre comercial:");
    if (nc) nombreComercial = nc.split(",")[0].trim();
    const rol = grab("Rol:");
    if (rol) roles.push(rol);
    const admins = grab("Administrador(es):");
    if (admins)
      administradores.push(...admins.split(",").map((a) => a.trim()).filter(Boolean));
    const bajaMatch = /baja[^0-9]*(\d{4}-\d{2}-\d{2})/i.exec(text);
    if (bajaMatch) bajaDate = bajaMatch[1];
  }

  const { localidad, provincia } = parseLocalidadProvincia(direccion);
  const nombreComercialEfectivo =
    nombreComercial ||
    stripLegalForm(nombre || empresa.replace(/^BdE#\s*\d+\s*/i, "")) ||
    nombre;

  return {
    pageId,
    nombre,
    empresa,
    estado,
    telefono,
    email,
    direccion,
    nif,
    codigoBde,
    roles,
    administradores,
    nombreComercial,
    websites,
    bajaDate,
    nombreComercialEfectivo,
    localidad,
    provincia,
    telefonoTipo: phoneType(telefono),
  };
}

/** Tagged error so the API route can map "property missing" → setup hint. */
export class MissingPropertyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingPropertyError";
  }
}

export async function updateEnrichmentProperties(
  pageId: string,
  data: {
    score: number;
    tier: string;
    resumen: string;
    prioridad?: string | null;
  },
): Promise<void> {
  const baseProps: Record<string, unknown> = {
    "ICP Score": { number: data.score },
    "ICP Tier": { select: { name: data.tier } },
    Enriquecido: { date: { start: new Date().toISOString().slice(0, 10) } },
    "Resumen IA": {
      rich_text: [{ type: "text", text: { content: data.resumen.slice(0, 2000) } }],
    },
  };
  const withPrioridad = data.prioridad
    ? { ...baseProps, Prioridad: { select: { name: data.prioridad } } }
    : baseProps;
  try {
    await notionFetch(`/pages/${pageId}`, {
      method: "PATCH",
      body: { properties: withPrioridad },
    });
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    // Prioridad is optional in the schema: if it's the one missing, retry without it.
    if (data.prioridad && /Prioridad/.test(msg) && /not a property/i.test(msg)) {
      await notionFetch(`/pages/${pageId}`, {
        method: "PATCH",
        body: { properties: baseProps },
      });
      return;
    }
    if (/not a property/i.test(msg)) {
      throw new MissingPropertyError(
        "Faltan propiedades de enriquecimiento en el CRM. Ejecuta `node scripts/setup-enrichment-props.mjs` una vez.",
      );
    }
    throw e;
  }
}

/**
 * Marker-based replace: delete the first heading starting with "📞 Call prep"
 * and everything after it, then append the fresh section. Re-runs are
 * idempotent — there is always at most one call-prep section.
 */
export async function replaceCallPrepSection(
  pageId: string,
  blocks: unknown[],
): Promise<void> {
  const children = await listAllChildren(pageId);
  const idx = children.findIndex(isCallPrepHeading);
  if (idx >= 0) {
    for (const block of children.slice(idx)) {
      // Serial awaits keep us under Notion's ~3 req/s.
      await notionFetch(`/blocks/${block.id}`, { method: "DELETE" });
    }
  }
  for (let i = 0; i < blocks.length; i += 100) {
    await notionFetch(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: { children: blocks.slice(i, i + 100) },
    });
  }
}
