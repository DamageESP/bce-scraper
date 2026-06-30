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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
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
      });
    }
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  return rows;
}

// Name of the structured CRM property that holds the BdE province. Kept as a
// Select so the CRM can filter/group prospects by province (e.g. "show me all
// Madrid prospects"). Notion auto-creates the option the first time a value is
// written, so we don't need to predefine the list.
const PROVINCIA_PROP = "Provincia";

// Resolves once we know the Provincia property exists on the data source:
// `true`  → safe to set it on new pages.
// `false` → schema couldn't be updated; skip it so page creation still works.
let provinciaPropReady: Promise<boolean> | null = null;

// Idempotently ensure the data source has a "Provincia" Select property.
// Notion's data source schema API (2025-09-03) lets us add a property without
// touching existing rows. Cached for the life of the server process. If the
// integration lacks "update database" permission, we degrade gracefully:
// the prospect is still created, just without the structured province.
async function ensureProvinciaProperty(): Promise<boolean> {
  if (!provinciaPropReady) {
    provinciaPropReady = (async () => {
      try {
        const ds = await notionFetch(`/data_sources/${DATA_SOURCE_ID}`);
        if (ds?.properties?.[PROVINCIA_PROP]) return true;
        await notionFetch(`/data_sources/${DATA_SOURCE_ID}`, {
          method: "PATCH",
          body: { properties: { [PROVINCIA_PROP]: { select: {} } } },
        });
        return true;
      } catch (e) {
        console.warn(
          `Notion: could not ensure "${PROVINCIA_PROP}" property; ` +
            `prospects will be created without it. ${(e as Error).message}`,
        );
        return false;
      }
    })();
  }
  return provinciaPropReady;
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
  if (ent.provincia && (await ensureProvinciaProperty())) {
    properties[PROVINCIA_PROP] = { select: { name: ent.provincia } };
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
