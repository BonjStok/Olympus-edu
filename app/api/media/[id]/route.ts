import { getEnv } from "@/lib/server/env";
import { serveMedia } from "@/lib/services/media";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return serveMedia(getEnv(), req, String(id ?? ""));
}
