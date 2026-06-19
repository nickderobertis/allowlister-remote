import { NextResponse } from "next/server";
import { enqueuePluginRequest } from "../../../../src/server/store";

export async function POST(request: Request) {
  const body = await request.json();
  const timeoutMs = Number(body.timeoutMs ?? 0);
  const approval = enqueuePluginRequest(body, timeoutMs);
  return NextResponse.json({ id: approval.id });
}
