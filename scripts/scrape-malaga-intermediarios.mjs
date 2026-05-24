#!/usr/bin/env node
// Scrape every "Intermediario de crédito inmobiliario" entity from the
// Banco de España Registro de Entidades that's located in Málaga province.
//
// The BdE search endpoint only takes a `q` text query and pagination; it
// does NOT support filtering by role or locality. So this script:
//   1. Enumerates every entity by iterating single-letter `q` queries
//      (a-z, ñ, 0-9), deduping by idelemento. Each search hit already
//      includes `roles`, so we filter to the target role straight away.
//   2. For each candidate, fetches the detail to read direccion.provincia.
//   3. Writes matches to scripts/output/malaga-intermediarios.json.
//
// All requests are sequential, with a configurable delay between them,
// so BdE never sees more than one in-flight request from this script.
// Progress is checkpointed to disk so a long run can be resumed.

import fs from "node:fs/promises";

const BASE_URL = "https://app.bde.es/rbe_out";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  Referer: "https://app.bde.es/rbe_spa/home",
  Origin: "https://app.bde.es",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "es-ES,es;q=0.9",
};

const TARGET_ROLE = "Intermediario de crédito inmobiliario";
const TARGET_PROVINCIA = "malaga"; // accent-stripped, lowercased
const DELAY_MS = 2000;
const PAGE_SIZE = 100;
const ENUM_QUERIES = "0123456789abcdefghijklmnopqrstuvwxyzñ".split("");

const OUT_DIR = "scripts/output";
const CANDIDATES_PATH = `${OUT_DIR}/all-candidates.json`;
const INTERMEDIARIOS_PATH = `${OUT_DIR}/intermediarios-all.json`;
const RESULTS_PATH = `${OUT_DIR}/malaga-intermediarios.json`;
const PROGRESS_PATH = `${OUT_DIR}/progress.json`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Some BdE pages return transient 500s — empirically a 10-60 s pause often
// clears them, while short retries do nothing. Longer schedule than the
// usual exponential.
const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 60000, 60000];

async function bdeFetch(path) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
      if (
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504 ||
        res.status === 429
      ) {
        lastErr = new Error(`${path} → HTTP ${res.status}`);
        if (attempt === RETRY_DELAYS_MS.length) break;
        const backoff = RETRY_DELAYS_MS[attempt];
        console.warn(`  ! HTTP ${res.status} (attempt ${attempt + 1}), retry in ${backoff / 1000}s`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.json();
    } catch (e) {
      lastErr = e;
      if (attempt === RETRY_DELAYS_MS.length) break;
      const backoff = RETRY_DELAYS_MS[attempt];
      console.warn(`  ! ${e.message} (attempt ${attempt + 1}), retry in ${backoff / 1000}s`);
      await sleep(backoff);
    }
  }
  throw lastErr ?? new Error(`${path} failed after retries`);
}

async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(path, data) {
  await fs.writeFile(path, JSON.stringify(data, null, 2));
}

const ENUM_STATE_PATH = `${OUT_DIR}/enum-state.json`;
const SATURATION_STREAK = 3; // stop after N consecutive queries with 0 new entities

async function enumerateAll() {
  const finalized = await readJson(CANDIDATES_PATH);
  if (finalized) {
    console.log(`[enum] cache hit: ${finalized.length} entities from ${CANDIDATES_PATH}`);
    return finalized;
  }
  // Resume from incremental state if present.
  const state = (await readJson(ENUM_STATE_PATH)) ?? {
    found: [],
    doneQueries: [],
    skipped: [],
    zeroStreak: 0,
  };
  const found = new Map(state.found.map((h) => [h.idelemento, h]));
  const doneQueries = new Set(state.doneQueries);
  const skipped = state.skipped;
  let zeroStreak = state.zeroStreak ?? 0;
  if (found.size > 0) {
    console.log(`[enum] resume: ${found.size} entities, ${doneQueries.size} queries done, streak=${zeroStreak}`);
  }

  for (const q of ENUM_QUERIES) {
    if (doneQueries.has(q)) continue;
    if (zeroStreak >= SATURATION_STREAK) {
      console.log(`[enum] saturated (${zeroStreak} consecutive queries added nothing); stopping enumeration.`);
      break;
    }
    const before = found.size;
    let page = 1;
    let total = null;
    while (true) {
      const path = `/elementos?q=${encodeURIComponent(q)}&sort=idelemento&sort_order=ASC&lang=ES&page=${page}&page_size=${PAGE_SIZE}`;
      let data;
      try {
        data = await bdeFetch(path);
      } catch (e) {
        console.warn(`  ✗ giving up on q="${q}" page=${page}: ${e.message}`);
        skipped.push({ q, page });
        if (total !== null) {
          const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
          if (page >= totalPages) break;
        } else if (page >= 30) {
          break;
        }
        page++;
        await sleep(DELAY_MS);
        continue;
      }
      if (total === null) total = data.numResultados ?? 0;
      const hits = data.elementos ?? [];
      let newCount = 0;
      for (const h of hits) {
        if (!found.has(h.idelemento)) {
          found.set(h.idelemento, h);
          newCount++;
        }
      }
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      console.log(
        `[enum] q="${q}" page ${page}/${totalPages} got ${hits.length} (+${newCount} new, total ${found.size})`,
      );
      if (page >= totalPages || hits.length === 0) break;
      page++;
      await sleep(DELAY_MS);
    }
    doneQueries.add(q);
    const addedThisQuery = found.size - before;
    if (addedThisQuery === 0) {
      zeroStreak++;
    } else {
      zeroStreak = 0;
    }
    // Checkpoint after every query.
    await writeJson(ENUM_STATE_PATH, {
      found: Array.from(found.values()),
      doneQueries: Array.from(doneQueries),
      skipped,
      zeroStreak,
    });
    await sleep(DELAY_MS);
  }
  const arr = Array.from(found.values());
  await writeJson(CANDIDATES_PATH, arr);
  if (skipped.length > 0) {
    await writeJson(`${OUT_DIR}/skipped-pages.json`, skipped);
    console.warn(`[enum] skipped ${skipped.length} page(s) after exhausting retries; dedup across letters usually compensates.`);
  }
  console.log(`[enum] done: ${arr.length} unique entities saved to ${CANDIDATES_PATH}`);
  return arr;
}

function pickIntermediarios(all) {
  const out = all.filter((h) => {
    const roles = h.roles ?? [];
    return roles.some(
      (r) => r.nombreRol === TARGET_ROLE && !r.fechaBajaRol,
    );
  });
  return out;
}

function summarizeDetail(hit, d) {
  const dir = d.direccion ?? {};
  const phones = [];
  const websites = [];
  for (const r of d.roles ?? []) {
    for (const t of r.telefonos ?? []) {
      if (t && !phones.includes(t)) phones.push(t);
    }
    if (r.paginaWeb && !websites.includes(r.paginaWeb)) websites.push(r.paginaWeb);
  }
  const docs = d.documentos ?? [];
  const nif = docs.find((x) => x.tipoDocumento === "NIF")?.numeroDocumento ?? null;
  const street = [dir.tipovia, dir.nombreVia, dir.numeroVia].filter(Boolean).join(" ");
  return {
    idelemento: hit.idelemento,
    nombre: (d.nombre || hit.nombre || "").trim(),
    nif,
    codigoBE: hit.codigoBE ?? d.codigoBE ?? null,
    tipoPersona: d.tipoPersona ?? hit.tipoPersona ?? null,
    direccion: street || null,
    localidad: dir.localidad ?? null,
    provincia: dir.provincia ?? null,
    codigoPostal: dir.codigoPostal ?? null,
    telefonos: phones,
    websites,
    nombreComerciales: hit.nombreComerciales ?? [],
    administradores: (d.administradores ?? [])
      .map((a) => a.nombreAdministrador)
      .filter(Boolean),
    detalleUrl: `https://app.bde.es/rbe_spa/detalle/${hit.idelemento}`,
  };
}

async function loadProgress() {
  const p = await readJson(PROGRESS_PATH);
  return p ?? { processed: [], matches: [] };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log(`[phase 1] enumerate every BdE entity (this is the slow bit)…`);
  const all = await enumerateAll();

  const intermediarios = pickIntermediarios(all);
  await writeJson(INTERMEDIARIOS_PATH, intermediarios);
  console.log(`[phase 2] ${intermediarios.length} active "${TARGET_ROLE}" candidates`);

  const progress = await loadProgress();
  const processed = new Set(progress.processed);
  const matches = progress.matches;
  console.log(`[phase 2] resume: ${processed.size} already processed, ${matches.length} already matched`);

  let i = 0;
  let nonMatchStreak = 0;
  for (const hit of intermediarios) {
    i++;
    if (processed.has(hit.idelemento)) continue;
    let detail;
    try {
      detail = await bdeFetch(`/elementos/${hit.idelemento}?lang=ES`);
    } catch (e) {
      console.warn(`  ! detail ${hit.idelemento} ${hit.nombre}: ${e.message}`);
      await sleep(DELAY_MS);
      continue;
    }
    processed.add(hit.idelemento);
    const provNorm = normalize(detail.direccion?.provincia);
    const locNorm = normalize(detail.direccion?.localidad);
    const isMalaga = provNorm.includes(TARGET_PROVINCIA) || locNorm.includes(TARGET_PROVINCIA);
    if (isMalaga) {
      const row = summarizeDetail(hit, detail);
      matches.push(row);
      nonMatchStreak = 0;
      console.log(
        `  ✓ ${i}/${intermediarios.length} ${hit.idelemento} ${hit.nombre} (${detail.direccion?.localidad || "?"}, ${detail.direccion?.provincia || "?"})`,
      );
    } else {
      nonMatchStreak++;
      if (nonMatchStreak % 25 === 0) {
        console.log(
          `  · ${i}/${intermediarios.length} processed (last match streak: ${nonMatchStreak} non-Málaga; total matches so far: ${matches.length})`,
        );
      }
    }
    if (processed.size % 20 === 0) {
      await writeJson(PROGRESS_PATH, {
        processed: Array.from(processed),
        matches,
      });
    }
    await sleep(DELAY_MS);
  }

  await writeJson(PROGRESS_PATH, {
    processed: Array.from(processed),
    matches,
  });
  await writeJson(RESULTS_PATH, matches);
  console.log("");
  console.log(`[done] ${matches.length} entities in Málaga`);
  console.log(`[done] results: ${RESULTS_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
