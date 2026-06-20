import { NextResponse } from "next/server";
import { enqueuePluginRequest } from "../../../../src/server/store";

export async function POST(request: Request) {
  const body = await request.json();
  const approval = enqueuePluginRequest(body);
  return NextResponse.json({ id: approval.id });
}
