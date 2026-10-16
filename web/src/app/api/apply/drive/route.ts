export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Agentic browser driving can mutate live employer forms and is disabled for v1. */
export async function POST(): Promise<Response> {
  return Response.json(
    { error: "Live application form filling is disabled. Navigate and complete the employer form manually." },
    { status: 410 },
  );
}
