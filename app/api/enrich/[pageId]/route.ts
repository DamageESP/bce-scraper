import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  getLeadContext,
  updateEnrichmentProperties,
  replaceCallPrepSection,
  MissingPropertyError,
} from "@/lib/notion";
import {
  runEnrichment,
  computeIcp,
  buildCallPrepBlocks,
  EnrichmentError,
} from "@/lib/enrich";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  req: Request,
  context: { params: Promise<{ pageId: string }> },
) {
  const { pageId } = await context.params;
  if (!pageId) {
    return NextResponse.json({ error: "pageId requerido" }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY no está configurada en el servidor" },
      { status: 500 },
    );
  }

  let skipPrioridad = false;
  try {
    const body = await req.json();
    skipPrioridad = body?.prioridad === false;
  } catch {}

  try {
    const lead = await getLeadContext(pageId);
    const { findings, usage } = await runEnrichment(lead);
    const icp = computeIcp(findings, lead);

    await updateEnrichmentProperties(pageId, {
      score: icp.score,
      tier: icp.tier,
      resumen: findings.resumen,
      prioridad: skipPrioridad ? null : icp.prioridad,
    });
    await replaceCallPrepSection(pageId, buildCallPrepBlocks(findings, icp));

    console.log(
      `[enrich] ${pageId} tier=${icp.tier} score=${icp.score} confianza=${findings.confianza} ` +
        `turns=${usage.turns} searches=${usage.web_search_requests} ` +
        `in=${usage.input_tokens} out=${usage.output_tokens} ` +
        `cache_write=${usage.cache_creation_input_tokens} cache_read=${usage.cache_read_input_tokens}`,
    );

    return NextResponse.json({
      ok: true,
      icp,
      resumen: findings.resumen,
      confianza: findings.confianza,
      websiteStatus: findings.website_status,
      usage,
    });
  } catch (e: any) {
    if (e instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Límite de peticiones de Anthropic alcanzado; reintenta en un momento." },
        { status: 429 },
      );
    }
    if (e instanceof MissingPropertyError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof EnrichmentError) {
      return NextResponse.json(
        { error: `Enriquecimiento fallido (${e.kind}): ${e.message}` },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: e?.message ?? "Error enriqueciendo el lead" },
      { status: 502 },
    );
  }
}
