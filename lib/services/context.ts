import type { Db } from "@/lib/server/db";
import type { ServerEnv } from "@/lib/server/env";

/** Who performs an action. Admins may see unpublished drafts; nobody sees deleted records. */
export interface Actor {
  userId: string;
  admin: boolean;
}

/** Everything a service call needs; built once per request by the API layer. */
export interface ServiceContext {
  db: Db;
  env: ServerEnv;
  actor: Actor;
  /** Request time in ms. One value per request keeps timestamps consistent. */
  now: number;
}
