import { answerSearchViaCli } from "./cli/hook.js";
import { createTsSurgeonGuard } from "./opencode-guard.js";

/**
 * opencode plugin entry: the package's `main`/`exports` point here so that
 * listing `@commoncurriculum/ts-surgeon` in opencode.json's `"plugin"` array
 * loads the guard directly (opencode calls every exported plugin function).
 * The CLI is unaffected — `bin` resolves to dist/index.js without going
 * through `exports`.
 *
 * Typed structurally instead of against `@opencode-ai/plugin` to keep the
 * package dependency-free for CLI users; createTsSurgeonGuard mirrors that
 * package's before/after hook contracts (throwing from before blocks a call).
 */
const TsSurgeonGuard = createTsSurgeonGuard(answerSearchViaCli);

export { TsSurgeonGuard };
