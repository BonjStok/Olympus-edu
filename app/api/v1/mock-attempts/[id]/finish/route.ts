import { methodNotAllowed } from "@/lib/api/v1/handler";
import { mockFinish } from "@/lib/api/v1/routes";

export const dynamic = "force-dynamic";
export const POST = mockFinish;

// Other methods get a JSON 405 with an Allow header.
const notAllowed = methodNotAllowed(["POST"]);
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
