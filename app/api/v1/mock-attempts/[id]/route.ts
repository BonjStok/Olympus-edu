import { methodNotAllowed } from "@/lib/api/v1/handler";
import { mockSave } from "@/lib/api/v1/routes";

export const dynamic = "force-dynamic";
export const PATCH = mockSave;

// Other methods get a JSON 405 with an Allow header.
const notAllowed = methodNotAllowed(["PATCH"]);
export const GET = notAllowed;
export const POST = notAllowed;
export const PUT = notAllowed;
export const DELETE = notAllowed;
