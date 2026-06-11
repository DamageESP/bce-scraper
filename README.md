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
| `ANTHROPIC_API_KEY` | for enrichment | Anthropic API key used by `POST /api/enrich/[pageId]` (server-side only). |

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
  the CRM data source with `Estado=Prospecto` and `Teléfono` set from
  `roles[*].telefonos`.
- `GET /api/notion/list` returns the current CRM rows for the side
  panel.
- `DELETE /api/notion/<pageId>` archives a CRM row.

The Notion token never leaves the server.

## Lead enrichment (ICP score + call prep)

`POST /api/enrich/<pageId>` researches one CRM lead with a single agentic
Claude call (`claude-opus-4-8` + server-side `web_search`/`web_fetch`),
then writes back into the same Notion page:

- Properties: **ICP Score** (0–100), **ICP Tier** (A–D select),
  **Enriquecido** (date), **Resumen IA** (rich text) and — if the
  property exists — **Prioridad** (A→Alta, B→Media, C/D→Baja; send
  `{"prioridad": false}` in the body to skip it).
- A replaceable **"📞 Call prep"** page section: resumen, company
  facts, Google-review signal, volume signals with evidence, the
  documentation-pain assessment, a call hook (callout), discovery
  questions, likely objections with suggested responses, subscores and
  up to 5 source bookmarks. Re-running deletes the old section and
  appends a fresh one (always exactly one section; everything above the
  marker is preserved and never fed back into the model).

Scoring is deterministic code over the model's rubric-judged subscores
(`0.35·volumen + 0.30·dolor + 0.20·pyme_local + 0.15·accesibilidad`),
with hard overrides: a BdE baja date forces tier D ("⛔ Baja BdE"), and
no website + no reviews caps the tier at C ("datos insuficientes").

One-time setup (idempotent — safe to re-run) to create the four
properties on the CRM data source:

```bash
NOTION_TOKEN=secret_... node scripts/setup-enrichment-props.mjs
```

In the UI each CRM row gets a tier badge (`A · 82`), the AI resumen and
an **Enriquecer** / **Re-enriquecer** button; **Enriquecer pendientes
(N)** runs a sequential client-side bulk pass over every row without a
tier (with progress, cancel, and a leave-page guard — completed leads
persist if you cancel). Expect 1–3 minutes and roughly $0.50–1.50 of
Anthropic usage per lead; per-lead token usage is logged server-side.

> Vercel note: the route sets `maxDuration = 300`. On the Hobby plan,
> enable Fluid Compute so the function can actually run that long.

## UI conventions

- **⛔ Baja · YYYY-MM-DD** badge next to the entity name when every
  role has a `fechaBajaRol`. The row is faded and the role tags are
  struck through, so deregistered companies are visually obvious. The
  Add button still works (relabelled "Añadir (baja)") — sometimes you
  want them as historical references.
- BdE search supports 1–50 characters: letters, digits, accents,
  spaces. The UI mirrors that validation client-side and the server
  re-checks it.

## File layout

    app/
      api/login/route.ts            POST  /api/login   set session cookie
      api/search/route.ts           GET   /api/search  proxy BdE search
      api/detail/[id]/route.ts      GET   /api/detail  proxy BdE detail
      api/notion/list/route.ts      GET   /api/notion/list   list CRM rows
      api/notion/add/route.ts       POST  /api/notion/add    create row
      api/notion/[pageId]/route.ts  DEL   /api/notion/[id]   archive row
      api/enrich/[pageId]/route.ts  POST  /api/enrich/[id]   AI-enrich one lead
      login/page.tsx                client UI
      page.tsx                      main client UI (search + CRM panel)
      layout.tsx, globals.css
    lib/
      auth.ts    HMAC session cookie (Web Crypto, runs on Edge)
      bde.ts    BdE client + normaliser (incl. fechaBajaRol → inactive)
      notion.ts  Notion client (list / create / archive / lead context / write-back)
      enrich.ts  enrichment engine (agentic Claude call, ICP scoring, call-prep blocks)
    scripts/
      setup-enrichment-props.mjs    one-time: add ICP props to the data source
    middleware.ts                   gates everything behind the cookie
