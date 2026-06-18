import { NextResponse } from "next/server";
import { getDecision } from "../../../../../../src/server/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const decision = getDecision(id);
  if (!decision) return NextResponse.json({ status: "pending" }, { status: 202 });
  return NextResponse.json(decision);
}
