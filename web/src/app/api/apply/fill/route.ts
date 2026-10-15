export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live employer-form fill is outside the human-governed v1 capability set. */
export async function POST(): Promise<Response> {
  return Response.json(
    { error: "Live application form filling is disabled. Complete the employer form manually." },
    { status: 410 },
  );
}
