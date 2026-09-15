import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Keep production's NodeNext .js imports while running the source tests.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && /^\.{1,2}\//.test(specifier) && specifier.endsWith(".js")) {
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (source.protocol === "file:" && existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
