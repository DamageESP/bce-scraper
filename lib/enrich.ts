// Lead-enrichment engine: one agentic Claude call per lead (web research)
// followed by deterministic ICP scoring and Notion block composition.

import Anthropic from "@anthropic-ai/sdk";
import type { LeadContext } from "./notion";

const MODEL = "claude-opus-4-8";
const MAX_TURNS = 10;
const MAX_NUDGES = 2;
const MAX_TOKENS_PER_TURN = 16000;

// ---------------------------------------------------------------------------
// Findings (what the model submits via the strict custom tool)
// ---------------------------------------------------------------------------

export type Subscore = { score: number; evidencia: string };

export type Findings = {
  resumen: string;
  website_status: "ok" | "sin_web" | "web_caida";
  web_verificada: string;
  empleados_estimado: string;
  oficinas: string;
  idiomas: string[];
  cliente_extranjero: boolean;
  canales: { whatsapp: boolean; formulario_web: boolean; otros: string };
  resenas_google: { count: number; rating: number; nota: string };
  senales_volumen: { senal: string; evidencia: string }[];
  dolor_documental: string;
  gancho_llamada: string;
  preguntas_descubrimiento: string[];
  objeciones: { objecion: string; respuesta_sugerida: string }[];
  subscores: {
    es_pyme_local: Subscore;
    volumen_operaciones: Subscore;
    dolor_documental: Subscore;
    accesibilidad_decisor: Subscore;
  };
  confianza: "alta" | "media" | "baja";
  fuentes: string[];
};

const SUBSCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "evidencia"],
  properties: {
    score: {
      type: "number",
      description: "0-10 según la rúbrica; usa -1 si es imposible juzgar",
    },
    evidencia: {
      type: "string",
      description:
        "Cita literal o URL de lo observado que justifica el score; 'no encontrado' si no hay evidencia",
    },
  },
} as const;

export const SUBMIT_FINDINGS_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: [
    "resumen",
    "website_status",
    "web_verificada",
    "empleados_estimado",
    "oficinas",
    "idiomas",
    "cliente_extranjero",
    "canales",
    "resenas_google",
    "senales_volumen",
    "dolor_documental",
    "gancho_llamada",
    "preguntas_descubrimiento",
    "objeciones",
    "subscores",
    "confianza",
    "fuentes",
  ],
  properties: {
    resumen: {
      type: "string",
      description: "1-2 frases: qué es esta empresa y por qué encaja (o no) en el ICP",
    },
    website_status: {
      type: "string",
      enum: ["ok", "sin_web", "web_caida"],
      description:
        "ok = web verificada como suya; sin_web = no se encontró o no se pudo verificar; web_caida = existe pero no responde",
    },
    web_verificada: {
      type: "string",
      description: "URL de la web verificada, o cadena vacía si website_status != ok",
    },
    empleados_estimado: {
      type: "string",
      description:
        'Rango + método, p.ej. "4-6 (página de equipo)" o "11-50 (LinkedIn)"; "no encontrado" si no hay datos',
    },
    oficinas: {
      type: "string",
      description: 'Número y ubicación de oficinas observadas, p.ej. "1 (Málaga centro)"; "no encontrado" si no hay datos',
    },
    idiomas: {
      type: "array",
      items: { type: "string" },
      description: "Idiomas de la web (selector de idioma o contenido), vacío si no aplica",
    },
    cliente_extranjero: {
      type: "boolean",
      description:
        "true si hay evidencia de foco en compradores extranjeros / no residentes (multi-idioma, 'mortgages for expats', etc.)",
    },
    canales: {
      type: "object",
      additionalProperties: false,
      required: ["whatsapp", "formulario_web", "otros"],
      properties: {
        whatsapp: {
          type: "boolean",
          description: "true si hay enlace wa.me / api.whatsapp.com o widget de WhatsApp",
        },
        formulario_web: {
          type: "boolean",
          description: "true si hay formularios de captación, calculadoras o CTA 'te llamamos'",
        },
        otros: { type: "string", description: "Otros canales observados, o cadena vacía" },
      },
    },
    resenas_google: {
      type: "object",
      additionalProperties: false,
      required: ["count", "rating", "nota"],
      properties: {
        count: {
          type: "number",
          description: "Número de reseñas según snippet citado; -1 si no encontrado. NUNCA estimar.",
        },
        rating: { type: "number", description: "Valoración media según snippet; -1 si no encontrado" },
        nota: {
          type: "string",
          description: "Snippet citado y pistas de recencia ('hace 2 semanas'), o 'no encontrado'",
        },
      },
    },
    senales_volumen: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["senal", "evidencia"],
        properties: {
          senal: { type: "string" },
          evidencia: { type: "string", description: "Cita literal o URL de lo observado" },
        },
      },
      description: "Señales de volumen de operaciones, cada una con su evidencia",
    },
    dolor_documental: {
      type: "string",
      description:
        "Prosa: por qué (o por qué no) esta empresa sufre el dolor de recopilar/revisar documentación",
    },
    gancho_llamada: {
      type: "string",
      description:
        "1-2 frases en tono de llamada hablada, ancladas en UN hecho concreto observado y ligadas al dolor documental",
    },
    preguntas_descubrimiento: {
      type: "array",
      items: { type: "string" },
      description: "2-3 preguntas adaptadas a lo que NO se sabe tras la investigación",
    },
    objeciones: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["objecion", "respuesta_sugerida"],
        properties: {
          objecion: { type: "string", description: 'Objeción prevista, p.ej. "YA TENEMOS portal"' },
          respuesta_sugerida: { type: "string", description: "Respuesta de una línea coherente con el guion" },
        },
      },
    },
    subscores: {
      type: "object",
      additionalProperties: false,
      required: [
        "es_pyme_local",
        "volumen_operaciones",
        "dolor_documental",
        "accesibilidad_decisor",
      ],
      properties: {
        es_pyme_local: SUBSCORE_SCHEMA,
        volumen_operaciones: SUBSCORE_SCHEMA,
        dolor_documental: SUBSCORE_SCHEMA,
        accesibilidad_decisor: SUBSCORE_SCHEMA,
      },
    },
    confianza: {
      type: "string",
      enum: ["alta", "media", "baja"],
      description: "Cuánta evidencia se encontró en total",
    },
    fuentes: {
      type: "array",
      items: { type: "string" },
      description: "URLs de las fuentes realmente consultadas u observadas en snippets",
    },
  },
};

// ---------------------------------------------------------------------------
// System prompt (static → cacheable). Procedure + rubrics in Spanish.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Eres un analista de prospección B2B para Vela, una herramienta para intermediarios de crédito hipotecario (brókers) en España que automatiza la parte más tediosa de su trabajo: recopilar la documentación de cada cliente (nóminas, vida laboral, declaraciones, escrituras…), perseguirla por WhatsApp y email con recordatorios, y revisarla una a una.

Tu trabajo: investigar UNA empresa intermediaria registrada en el Banco de España y entregar hallazgos estructurados para (a) puntuar su encaje como cliente ideal y (b) preparar la llamada en frío de Víctor, el fundador (llamada de descubrimiento, tono cercano, nada de venta agresiva).

El cliente ideal (ICP): bróker hipotecario PYME, local e independiente, con volumen suficiente de operaciones para sentir el dolor documental a diario, y con un decisor accesible (idealmente el administrador es el operador del día a día).

PRESUPUESTO: máximo 8 búsquedas y 4 fetch. Gástalo con cabeza siguiendo este procedimiento en orden.

== ETAPA 1 — RESOLUCIÓN DE IDENTIDAD (≤1 búsqueda + 1 fetch) ==
Antes de nada, establece qué presencia web pertenece REALMENTE a esta empresa. Enriquecer con la identidad equivocada es peor que no enriquecer.
1. Si hay web en la ficha: haz fetch de la portada. VERIFICA la identidad: el NIF, el teléfono o la dirección del registro deben aparecer en el sitio (footer, aviso legal, /contacto), o la marca debe coincidir claramente con el nombre comercial. Si no coincide → trátala como "web desconocida" y pasa a descubrimiento.
2. Si no hay web (o la verificación falló): UNA búsqueda — "<nombre comercial>" <localidad> hipotecas (alternativa: el NIF tal cual). Toma el primer candidato orgánico razonable, haz fetch y verifica igual.
3. Si sigue sin verificarse: website_status = "sin_web"; continúa solo con señales de búsqueda (etapa 3) y valores conservadores. NUNCA atribuyas a la empresa el contenido de una web no verificada.

== ETAPA 2 — ANÁLISIS DE LA WEB (1-2 fetch más) ==
Desde la navegación de la portada, haz fetch de las 1-2 subpáginas más informativas (prioridad: /equipo | /quienes-somos | /sobre-nosotros → /servicios → /contacto). Checklist de extracción (cada punto alimenta una señal de scoring):
- Página de equipo: nombres y nº de personas → empleados_estimado; es_pyme_local; accesibilidad (¿el administrador del registro es la cara visible?).
- Direcciones de oficinas / "nuestras oficinas" → es_pyme_local (1-2 locales = PYME; multi-provincia = red).
- Marca de franquicia o red en footer/logo ("Grupo X", marcas nacionales) → penaliza es_pyme_local.
- Selector de idiomas, contenido "mortgages for expats" / "no residentes" → cliente_extranjero. Es la señal de dolor MÁS fuerte: los expedientes de no residentes llevan mucha más documentación (rentas extranjeras, traducciones, apostillas).
- Productos: autónomos, reunificación, hipoteca 100%, no residentes → dolor (perfiles complejos = más documentos por operación).
- Enlaces wa.me / api.whatsapp.com o widget de WhatsApp → canales.whatsapp (su operativa ya vive en WhatsApp; encaje perfecto con el pitch).
- Formularios de captación, calculadoras hipotecarias, CTA "te llamamos" → volumen (captación activa).
- Blog: fecha del último post → volumen (marketing activo) vs web muerta.
- Portal de clientes / "área de clientes" / software con nombre → DESCUENTA dolor y predice la objeción "YA TENEMOS".

== ETAPA 3 — REPUTACIÓN Y HUELLA (2-4 búsquedas, SOLO snippets) ==
Regla estricta: las reseñas y los datos de LinkedIn salen SOLO de los snippets de búsqueda — no hagas fetch de Google Maps ni LinkedIn (fallan o queman el presupuesto).
1. "<nombre comercial>" reseñas <localidad> → patrón en snippet tipo «4,9 ★ (137)» → resenas_google.count/rating; anota pistas de recencia ("hace 2 semanas"). El número de reseñas es el MEJOR proxy público de flujo de clientes en este segmento: los brókers piden reseña por expediente cerrado. ~0 reseñas → flujo mínimo; 20-100 con recientes → volumen estable; >100 y fluyendo → volumen alto.
2. "<nombre comercial>" linkedin → tramo de empleados de la página de empresa ("11-50 empleados") + si el administrador tiene perfil/cargo visible.
3. "<nombre comercial>" idealista OR habitaclia → perfil de agente en portales (señal de volumen y canal de entrada).
4. Opcionales (si queda presupuesto): "<administrador>" <localidad> para confirmar que el decisor es el operador; "<nombre>" opiniones; "<nombre>" empleo OR "estamos contratando" (contratar = crecer).

== REGLA DE EVIDENCIA (anti-alucinación) ==
Cada señal, la evidencia de cada subscore y el ancla factual del gancho deben citar algo realmente visto (URL o texto del snippet). Si un dato no se encontró, se reporta como "no encontrado" — NUNCA se estima ni se inventa. El número de reseñas debe salir de un snippet citado. Las URLs de fuentes deben ser las realmente consultadas.

== RÚBRICAS (puntúa cada dimensión 0-10 EXACTAMENTE contra estas tablas) ==

es_pyme_local:
- 0-2: banco, red nacional, franquicia grande, >50 empleados.
- 3-5: franquicia local, o 20-50 empleados, o multi-provincia.
- 6-8: independiente, 5-20 empleados, 1-3 oficinas.
- 9-10: independiente local, 1-15 empleados, 1-2 oficinas, marca propia, owner-operator.

volumen_operaciones:
- 0-2: sin reseñas, web muerta o sin web, sin señales.
- 3-5: <20 reseñas o actividad esporádica.
- 6-8: 20-100 reseñas con recientes, equipo 3+, captación activa (formularios/blog/portales).
- 9-10: >100 reseñas y flujo reciente, varios asesores, captación multicanal.

dolor_documental:
- 0-2: portal/automatización propia evidente y mercado nacional simple.
- 3-5: mercado nacional estándar, sin señales especiales.
- 6-8: WhatsApp como canal, perfiles complejos (autónomos, reunificación), volumen alto con equipo pequeño.
- 9-10: foco no-residentes/extranjero (multi-idioma) + WhatsApp + volumen alto y equipo pequeño.

accesibilidad_decisor:
- 0-2: decisor no identificable, estructura corporativa.
- 3-5: decisor identificado pero estructura mediana/jerárquica.
- 6-8: administrador visible como gestor del día a día.
- 9-10: owner-operator claro: administrador = cara visible, móvil directo, equipo ≤5.

Reporta también confianza (alta|media|baja) según cuánta evidencia encontraste en total.

== COMPOSICIÓN DEL CALL PREP ==
- gancho_llamada: 1-2 frases en tono de llamada hablada (no prosa de email), ancladas en UN hecho concreto observado ("he visto que trabajáis mucho con compradores extranjeros…") y ligadas al dolor de perseguir documentación del guion de Víctor (recopilar documentación por WhatsApp, recordatorios, revisión). Sin peloteo ni relleno genérico.
- preguntas_descubrimiento: 2-3, adaptadas a lo que NO se sabe tras la investigación (p.ej. si viste portal → "¿cómo os llega hoy la documentación, por el portal o acabáis en WhatsApp igualmente?").
- objeciones: previstas a partir del contexto observado y formuladas para mapear a las secciones del guion existente (portal visto → "YA TENEMOS"; equipo diminuto → "NO TENEMOS TIEMPO"), cada una con respuesta sugerida de una línea coherente con el guion.

== ENTREGA ==
Cuando termines la investigación, llama a la herramienta submit_findings EXACTAMENTE UNA VEZ con todos los campos. No escribas el informe como texto libre: la única salida válida es la llamada a submit_findings.`;

// ---------------------------------------------------------------------------
// User message (volatile, after the cached prefix)
// ---------------------------------------------------------------------------

function buildLeadBrief(lead: LeadContext): string {
  const lines = [
    "Investiga esta empresa del registro del Banco de España:",
    "",
    `Razón social: ${lead.nombre || lead.empresa || "(desconocida)"}`,
    `Nombre comercial (usa este para buscar): ${lead.nombreComercialEfectivo}`,
  ];
  if (lead.nif) lines.push(`NIF: ${lead.nif}`);
  if (lead.codigoBde) lines.push(`Código BdE: ${lead.codigoBde}`);
  if (lead.direccion) lines.push(`Dirección registrada: ${lead.direccion}`);
  if (lead.localidad || lead.provincia)
    lines.push(
      `Localidad/provincia: ${[lead.localidad, lead.provincia].filter(Boolean).join(", ")}`,
    );
  if (lead.telefono)
    lines.push(
      `Teléfono registrado: ${lead.telefono}${
        lead.telefonoTipo ? ` (${lead.telefonoTipo === "movil" ? "móvil — posible línea directa del decisor" : "fijo"})` : ""
      }`,
    );
  if (lead.email) lines.push(`Email: ${lead.email}`);
  if (lead.roles.length) lines.push(`Rol(es) BdE: ${lead.roles.join("; ")}`);
  if (lead.administradores.length)
    lines.push(`Administrador(es): ${lead.administradores.join("; ")}`);
  if (lead.websites.length)
    lines.push(`Web(s) en la ficha: ${lead.websites.join(" , ")}`);
  else lines.push("Web(s) en la ficha: ninguna");
  if (lead.bajaDate)
    lines.push(
      `⚠️ ATENCIÓN: entidad dada de BAJA en el BdE (${lead.bajaDate}). Investiga igualmente pero anótalo en el resumen.`,
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Agentic loop
// ---------------------------------------------------------------------------

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
  turns: number;
};

export class EnrichmentError extends Error {
  constructor(
    message: string,
    public readonly kind: "refusal" | "max_turns" | "no_findings",
  ) {
    super(message);
  }
}

function accumulateUsage(totals: UsageTotals, usage: Anthropic.Messages.Usage) {
  totals.input_tokens += usage.input_tokens ?? 0;
  totals.output_tokens += usage.output_tokens ?? 0;
  totals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  totals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  totals.web_search_requests +=
    usage.server_tool_use?.web_search_requests ?? 0;
}

export async function runEnrichment(
  lead: LeadContext,
): Promise<{ findings: Findings; usage: UsageTotals }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY env var is not set");
  }
  const client = new Anthropic();

  const tools: Anthropic.Messages.ToolUnion[] = [
    { type: "web_search_20260209", name: "web_search", max_uses: 8 },
    {
      type: "web_fetch_20260209",
      name: "web_fetch",
      max_uses: 4,
      max_content_tokens: 15000,
    },
    {
      name: "submit_findings",
      description:
        "Entrega los hallazgos estructurados de la investigación. Llamar exactamente una vez, al final.",
      input_schema: SUBMIT_FINDINGS_SCHEMA as Anthropic.Messages.Tool.InputSchema,
      strict: true,
    },
  ];

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildLeadBrief(lead) },
  ];

  const usage: UsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_requests: 0,
    turns: 0,
  };

  let nudges = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS_PER_TURN,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools,
      messages,
    });
    usage.turns += 1;
    accumulateUsage(usage, response.usage);

    const findingsCall = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === "submit_findings",
    );
    if (findingsCall) {
      // Client-side custom tool: capture the input as the result and stop —
      // no tool_result round-trip needed.
      return { findings: findingsCall.input as Findings, usage };
    }

    if (response.stop_reason === "refusal") {
      throw new EnrichmentError(
        "El modelo rechazó la petición (refusal).",
        "refusal",
      );
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") {
      // Server-tool loop paused; re-send as-is, the API resumes automatically.
      continue;
    }

    // end_turn (or max_tokens) without the tool call → nudge, max 2.
    if (nudges >= MAX_NUDGES) {
      throw new EnrichmentError(
        "El modelo terminó sin llamar a submit_findings tras varios avisos.",
        "no_findings",
      );
    }
    nudges += 1;
    messages.push({
      role: "user",
      content:
        "Llama ahora a la herramienta submit_findings con los hallazgos que tengas (usa 'no encontrado' / -1 donde falte evidencia).",
    });
  }

  throw new EnrichmentError(
    `La investigación no terminó en ${MAX_TURNS} turnos.`,
    "max_turns",
  );
}

// ---------------------------------------------------------------------------
// Deterministic ICP scoring (weights live here, tunable without re-research)
// ---------------------------------------------------------------------------

export type IcpResult = {
  score: number;
  tier: "A" | "B" | "C" | "D";
  nota: string | null;
  prioridad: "Alta" | "Media" | "Baja";
};

function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(10, v));
}

export function computeIcp(findings: Findings, lead: LeadContext): IcpResult {
  const s = findings.subscores;
  const score = Math.round(
    10 *
      (0.35 * clampScore(s.volumen_operaciones?.score) +
        0.3 * clampScore(s.dolor_documental?.score) +
        0.2 * clampScore(s.es_pyme_local?.score) +
        0.15 * clampScore(s.accesibilidad_decisor?.score)),
  );

  let tier: IcpResult["tier"] =
    score >= 75 ? "A" : score >= 55 ? "B" : score >= 35 ? "C" : "D";
  let nota: string | null = null;

  // Hard overrides.
  if (lead.bajaDate) {
    tier = "D";
    nota = "⛔ Baja BdE";
  } else if (
    findings.website_status === "sin_web" &&
    (findings.resenas_google?.count ?? -1) <= 0
  ) {
    if (tier === "A" || tier === "B") tier = "C";
    nota = "datos insuficientes";
  }

  const prioridad: IcpResult["prioridad"] =
    tier === "A" ? "Alta" : tier === "B" ? "Media" : "Baja";

  return { score, tier, nota, prioridad };
}

// ---------------------------------------------------------------------------
// Notion block composition for the "📞 Call prep" section
// ---------------------------------------------------------------------------

export const CALL_PREP_MARKER = "📞 Call prep";

type NotionBlock = Record<string, unknown>;

function rt(content: string) {
  return [{ type: "text", text: { content: content.slice(0, 2000) } }];
}

function heading2(text: string): NotionBlock {
  return { object: "block", type: "heading_2", heading_2: { rich_text: rt(text) } };
}

function heading3(text: string): NotionBlock {
  return { object: "block", type: "heading_3", heading_3: { rich_text: rt(text) } };
}

function para(text: string): NotionBlock {
  return { object: "block", type: "paragraph", paragraph: { rich_text: rt(text) } };
}

function bullet(text: string): NotionBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: rt(text) },
  };
}

function callout(text: string): NotionBlock {
  return {
    object: "block",
    type: "callout",
    callout: { rich_text: rt(text), icon: { type: "emoji", emoji: "🎯" } },
  };
}

function bookmarkBlock(url: string): NotionBlock {
  return { object: "block", type: "bookmark", bookmark: { url } };
}

function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildCallPrepBlocks(
  findings: Findings,
  icp: IcpResult,
): NotionBlock[] {
  const fecha = new Date().toISOString().slice(0, 10);
  const blocks: NotionBlock[] = [];

  blocks.push(
    heading2(
      `${CALL_PREP_MARKER} — ${fecha} — ${icp.tier} ${icp.score}/100 · confianza ${findings.confianza}` +
        (icp.nota ? ` · ${icp.nota}` : ""),
    ),
  );
  if (findings.resumen) blocks.push(para(findings.resumen));

  const facts: string[] = [];
  facts.push(
    findings.website_status === "ok" && findings.web_verificada
      ? `Web: ${findings.web_verificada}`
      : `Web: ${findings.website_status === "web_caida" ? "caída" : "no verificada"}`,
  );
  if (findings.empleados_estimado) facts.push(`Empleados: ${findings.empleados_estimado}`);
  if (findings.oficinas) facts.push(`Oficinas: ${findings.oficinas}`);
  if (findings.idiomas?.length) facts.push(`Idiomas: ${findings.idiomas.join(", ")}`);
  facts.push(`Cliente extranjero: ${findings.cliente_extranjero ? "sí" : "no"}`);
  facts.push(`WhatsApp: ${findings.canales?.whatsapp ? "sí" : "no"}`);
  if (findings.canales?.formulario_web) facts.push("Formulario web: sí");
  if (findings.canales?.otros) facts.push(`Otros canales: ${findings.canales.otros}`);
  blocks.push(para(facts.join(" · ")));

  const r = findings.resenas_google;
  blocks.push(
    para(
      r && r.count >= 0
        ? `Reseñas Google: ${r.rating >= 0 ? `${r.rating}★ ` : ""}(${r.count})${r.nota ? ` — ${r.nota}` : ""}`
        : `Reseñas Google: no encontradas${r?.nota && r.nota !== "no encontrado" ? ` — ${r.nota}` : ""}`,
    ),
  );

  if (findings.senales_volumen?.length) {
    blocks.push(heading3("Señales de volumen"));
    for (const s of findings.senales_volumen.slice(0, 8)) {
      blocks.push(bullet(`${s.senal} — ${s.evidencia}`));
    }
  }

  if (findings.dolor_documental)
    blocks.push(para(`Dolor documental: ${findings.dolor_documental}`));

  if (findings.gancho_llamada) blocks.push(callout(findings.gancho_llamada));

  if (findings.preguntas_descubrimiento?.length) {
    blocks.push(heading3("Preguntas de descubrimiento"));
    for (const q of findings.preguntas_descubrimiento.slice(0, 5)) {
      blocks.push(bullet(q));
    }
  }

  if (findings.objeciones?.length) {
    blocks.push(heading3("Objeciones probables"));
    for (const o of findings.objeciones.slice(0, 5)) {
      blocks.push(bullet(`${o.objecion} → ${o.respuesta_sugerida}`));
    }
  }

  const sub = findings.subscores;
  blocks.push(
    para(
      `Subscores: PYME local ${clampScore(sub.es_pyme_local?.score)} · ` +
        `Volumen ${clampScore(sub.volumen_operaciones?.score)} · ` +
        `Dolor ${clampScore(sub.dolor_documental?.score)} · ` +
        `Accesibilidad ${clampScore(sub.accesibilidad_decisor?.score)}`,
    ),
  );

  for (const f of (findings.fuentes ?? []).filter(isHttpUrl).slice(0, 5)) {
    blocks.push(bookmarkBlock(f));
  }

  return blocks;
}
