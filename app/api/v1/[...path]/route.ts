// Any /api/v1 path without its own route: a JSON 404 in the API error format.
import { unknownEndpoint } from "@/lib/api/v1/handler";

export const dynamic = "force-dynamic";
export const GET = unknownEndpoint;
export const POST = unknownEndpoint;
export const PUT = unknownEndpoint;
export const PATCH = unknownEndpoint;
export const DELETE = unknownEndpoint;
