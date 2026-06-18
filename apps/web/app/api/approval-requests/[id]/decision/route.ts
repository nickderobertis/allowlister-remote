import { NextResponse } from "next/server";
import { decideRequest } from "../../../../../src/server/store";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await request.json();
  if (body.verdict !== "allow" && body.verdict !== "deny") {
    return NextResponse.json(
      { error: "verdict must be allow or deny" },
      { status: 400 },
    );
  }
  decideRequest(id, {
    requestId: id,
    verdict: body.verdict,
    reason: body.reason ?? `remote ${body.verdict}`,
  });
  return NextResponse.json({ ok: true });
}
