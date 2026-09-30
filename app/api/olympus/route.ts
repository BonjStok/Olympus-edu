// Mini-app RPC. Handlers live in lib/api/olympus; the contract is lib/domain/types.ts.
import {
  handleOlympusGet,
  handleOlympusOtherMethod,
  handleOlympusPost,
} from "@/lib/api/olympus/dispatcher";

export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleOlympusGet(req);
}

export function POST(req: Request): Promise<Response> {
  return handleOlympusPost(req);
}

export const PUT = handleOlympusOtherMethod;
export const PATCH = handleOlympusOtherMethod;
export const DELETE = handleOlympusOtherMethod;
export const OPTIONS = handleOlympusOtherMethod;
