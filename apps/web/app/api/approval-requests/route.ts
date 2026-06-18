import { NextResponse } from "next/server";
import { listPendingRequests } from "../../../src/server/store";

export async function GET() {
  return NextResponse.json(listPendingRequests());
}
