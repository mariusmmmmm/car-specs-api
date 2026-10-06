import { Hono } from "hono";
import type { Env } from "../types";
import { requestDemoKey } from "./keys-demo";
import { formCors } from "../middleware/form-cors";

export const keys = new Hono<{ Bindings: Env }>();
keys.use("*", formCors);

// Re-exported for the callers that imported them from here before the shared
// module existed.
export { TOS_VERSION, normaliseWebsite } from "../lib/key-request";

// A request is cheap to send and costs us a verification email, so cap it per IP.
export const REQUESTS_PER_IP_PER_DAY = 3;

// POST /v1/keys is now an ALIAS of POST /v1/keys/demo (owner decision
// 2026-10-06). There is no reviewed Free tier any more — nothing self-serve
// reaches the full catalogue — so the two endpoints would have done the same
// thing, and a cached page or a copied curl line posting here should keep
// working rather than 404 into silence.
//
// What this used to be: a handler that recorded a request for the owner to
// approve by hand (T73), after self-issued keys took 85–99% of the catalogue on
// 30–31 August. The review is gone because the thing it was guarding — a key
// that reaches the catalogue — is gone.
keys.post("/", requestDemoKey);
