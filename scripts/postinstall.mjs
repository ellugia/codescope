import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const setupCommand = join(packageRoot, "bin", "codescope.mjs");
const setupHint = `node node_modules/codescope/bin/codescope.mjs setup`;
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

if (!interactive) {
  console.warn(`CodeScope was installed. Run \`${setupHint}\` from this installation directory to configure it.`);
} else {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question("Launch the guided CodeScope setup now? [Y/n] ")).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      const result = spawnSync(process.execPath, [setupCommand, "setup"], { stdio: "inherit", windowsHide: true });
      if (result.error || result.status !== 0) console.warn(`CodeScope setup did not complete. You can run \`${setupHint}\` later.`);
    } else {
      console.warn(`Setup skipped. Run \`${setupHint}\` later when you are ready.`);
    }
  } finally {
    input.close();
  }
}
