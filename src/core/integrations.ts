// Every outside-service integration, in the order updates run them.
import { cronometer } from "./cronometer/integration.ts";
import type { Integration } from "./integration.ts";

export const INTEGRATIONS: Integration[] = [cronometer];
