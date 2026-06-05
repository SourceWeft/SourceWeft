import type { NextRequest } from "next/server";
import { proxyArtifactFile } from "./artifact-file-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return proxyArtifactFile(request);
}
