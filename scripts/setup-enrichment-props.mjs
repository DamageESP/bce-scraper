#!/usr/bin/env node
// One-time, idempotent: adds the enrichment properties to the CRM data source.
//
//   NOTION_TOKEN=secret_... node scripts/setup-enrichment-props.mjs
//
// Optional: NOTION_DATA_SOURCE_ID to target a different data source.

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
const DATA_SOURCE_ID =
  process.env.NOTION_DATA_SOURCE_ID ?? "5758708d-7db9-824a-a4b8-879b6e6311eb";

const token = process.env.NOTION_TOKEN;
if (!token) {
  console.error("NOTION_TOKEN env var is not set");
  process.exit(1);
}

const DESIRED = {
  "ICP Score": { number: { format: "number" } },
  "ICP Tier": {
    select: {
      options: [
        { name: "A", color: "green" },
        { name: "B", color: "yellow" },
        { name: "C", color: "orange" },
        { name: "D", color: "red" },
      ],
    },
  },
  Enriquecido: { date: {} },
  "Resumen IA": { rich_text: {} },
};

async function notionFetch(path, init = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    throw new Error(
      `Notion ${init.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`,
    );
  }
  return res.json();
}

const ds = await notionFetch(`/data_sources/${DATA_SOURCE_ID}`);
const existing = ds.properties ?? {};

const toAdd = {};
for (const [name, schema] of Object.entries(DESIRED)) {
  if (existing[name]) {
    console.log(`✓ "${name}" already present (${existing[name].type})`);
  } else {
    toAdd[name] = schema;
  }
}

if (Object.keys(toAdd).length === 0) {
  console.log("Nothing to do — all enrichment properties already exist.");
  process.exit(0);
}

await notionFetch(`/data_sources/${DATA_SOURCE_ID}`, {
  method: "PATCH",
  body: { properties: toAdd },
});
for (const name of Object.keys(toAdd)) console.log(`+ added "${name}"`);
console.log("Done.");
