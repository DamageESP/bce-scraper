# BdE → Notion CRM (web app)

A small Next.js 15 app that lets you search the Banco de España
"Registro de Entidades" (https://app.bde.es/rbe_spa/home), click
**Añadir al CRM** on the entities you want, and pushes them into the
Notion `👟 CRM de ventas` database as `Estado = Prospecto` rows. A
side panel shows the current CRM contents and lets you delete rows.
Entities that have been deregistered (every role has `fechaBajaRol`)
are shown with a red ⛔ Baja badge and dashed styling.

## Deploy from your laptop

```bash
# 1. Unpack
tar -xzf bde-crm-app.tar.gz
cd bde-crm-app

# 2. (Optional) install + smoke test locally
npm install
APP_PASSWORD=test SESSION_SECRET=$(openssl rand -hex 32) \
  NOTION_TOKEN=secret_... npm run dev
# → http://localhost:3000

# 3. Deploy to Vercel
npm i -g vercel    # if you don't already have the CLI
vercel login       # one-time

# Initial deploy + project link (pick the "Encuentra tu Hogar" scope):
vercel link
vercel deploy --prod

# Set the three required env vars in the dashboard or via CLI:
vercel env add APP_PASSWORD         production   # the login password
vercel env add SESSION_SECRET       production   # `openssl rand -hex 32`
vercel env add NOTION_TOKEN         production   # secret_… (your integration)

# Trigger a redeploy that picks them up:
vercel deploy --prod
```

After the deploy, the URL Vercel prints is your app. Visit it, enter
the `APP_PASSWORD`, and start searching.

## Required env vars

| Name | Required | Purpose |
| --- | --- | --- |
| `APP_PASSWORD` | yes | Shared login password for the site. |
| `SESSION_SECRET` | yes | Random string used to sign session cookies (`openssl rand -hex 32`). |
| `NOTION_TOKEN` | yes | Internal-integration token, with the CRM database added as a connection. |
| `NOTION_DATA_SOURCE_ID` | no | Override the CRM data source (defaults to `5758708d-7db9-824a-a4b8-879b6e6311eb`). |

## How it works

- Middleware blocks every route except `/login` and `/api/login`
  unless the visitor has a valid HMAC-signed session cookie. The
  cookie's signature is verified with `SESSION_SECRET`.
- `POST /api/login` checks the password (constant-time compare) and
  sets the cookie.
- `GET /api/search?q=...` calls
  `https://app.bde.es/rbe_out/elementos` server-side and returns the
  hits as-is (so the UI can read `roles[*].fechaBajaRol`).
- `POST /api/notion/add` (body `{ "idelemento": <id> }`) fetches the
  entity detail from BdE, normalises it (address, phone, NIF/LEI,
  websites, administrators, baja date) and creates a Notion page in
  the CRM data source with `Estado=Prospecto`, `Teléfono` set from
  `roles[*].telefonos`, and `Provincia` (a Select) set from the BdE
  address. The `Provincia` property is created on the data source
  automatically the first time a prospect is added, so the CRM can be
  filtered/grouped by province. If the integration lacks permission to
  update the schema, the prospect is still created without it.
- `GET /api/notion/list` returns the current CRM rows for the side
  panel.
- `DELETE /api/notion/<pageId>` archives a CRM row.

The Notion token never leaves the server.

## UI conventions

- **⛔ Baja · YYYY-MM-DD** badge next to the entity name when every
  role has a `fechaBajaRol`. The row is faded and the role tags are
  struck through, so deregistered companies are visually obvious. The
  Add button still works (relabelled "Añadir (baja)") — sometimes you
  want them as historical references.
- BdE search supports 1–50 characters: letters, digits, accents,
  spaces. The UI mirrors that validation client-side and the server
  re-checks it.

## Bulk scraper (`scripts/scrape-intermediarios.mjs`)

For pulling a whole province's worth of "Intermediario de crédito
inmobiliario" entities at once (rather than adding them one-by-one in
the UI), there's a standalone Node script:

```bash
node scripts/scrape-intermediarios.mjs madrid
# or
TARGET_PROVINCIA=malaga DELAY_MS=2000 node scripts/scrape-intermediarios.mjs
```

The province is matched accent-insensitively against the BdE
`provincia`/`localidad` fields. Output goes to `scripts/output/`
(git-ignored):

- `<provincia>-intermediarios.json` — the matched entities.
- `<provincia>-progress.json` — resumable phase-2 progress.

Because the BdE search API has **no** server-side role or locality
filter (unknown query params are rejected), the script enumerates the
entire registry by iterating single-letter `q` queries, dedupes by
`idelemento`, then fetches each `Intermediario` candidate's detail to
read its province. That enumeration is province-independent, so it's
cached in `scripts/output/all-candidates.json` and reused across
provinces — the first run is slow (the full registry is tens of
thousands of entities and BdE throttles sustained requests with
transient 500s, which the script retries through), but a second
province only re-runs the fast phase-2 filter.

Everything is checkpointed after every query/batch, so a long run can
be stopped and resumed. `DELAY_MS` (default 2000) tunes the polite
delay between sequential requests.

## File layout

    app/
      api/login/route.ts            POST  /api/login   set session cookie
      api/search/route.ts           GET   /api/search  proxy BdE search
      api/detail/[id]/route.ts      GET   /api/detail  proxy BdE detail
      api/notion/list/route.ts      GET   /api/notion/list   list CRM rows
      api/notion/add/route.ts       POST  /api/notion/add    create row
      api/notion/[pageId]/route.ts  DEL   /api/notion/[id]   archive row
      login/page.tsx                client UI
      page.tsx                      main client UI (search + CRM panel)
      layout.tsx, globals.css
    lib/
      auth.ts    HMAC session cookie (Web Crypto, runs on Edge)
      bde.ts    BdE client + normaliser (incl. fechaBajaRol → inactive)
      notion.ts  Notion client (list / create + Provincia prop / archive)
    scripts/
      scrape-intermediarios.mjs     bulk per-province scraper (see above)
    middleware.ts                   gates everything behind the cookie
