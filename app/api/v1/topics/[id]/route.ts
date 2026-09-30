import { methodNotAllowed } from "@/lib/api/v1/handler";
import { topic } from "@/lib/api/v1/routes";

export const dynamic = "force-dynamic";
export const GET = topic;

// Other methods get a JSON 405 with an Allow header.
const notAllowed = methodNotAllowed(["GET"]);
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
