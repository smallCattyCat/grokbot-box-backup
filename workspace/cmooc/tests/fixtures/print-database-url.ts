import { ensureAppEnvLoaded } from "../../lib/env";

ensureAppEnvLoaded();
process.stdout.write(process.env.DATABASE_URL ?? "");
