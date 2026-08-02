import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { assertRuntimeConfiguration } from "@/lib/config";

const handlers = toNextJsHandler(auth);

function guarded(handler: (request: Request) => Promise<Response>) {
  return (request: Request) => {
    assertRuntimeConfiguration();
    return handler(request);
  };
}

export const GET = guarded(handlers.GET);
export const POST = guarded(handlers.POST);
export const PATCH = guarded(handlers.PATCH);
export const PUT = guarded(handlers.PUT);
export const DELETE = guarded(handlers.DELETE);
