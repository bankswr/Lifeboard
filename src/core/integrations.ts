// Every outside-service integration, in the order updates run them.
import { cronometer } from "./cronometer/integration.ts";
import { google } from "./google/integration.ts";
import type { Integration } from "./integration.ts";
import { smartlife } from "./smartlife/integration.ts";
import { whisker } from "./whisker/integration.ts";

export const INTEGRATIONS: Integration[] = [whisker, smartlife, cronometer, google];
