import { createBridge, loadConfig, toSafeError } from "../src/bridge.mjs";

const args = process.argv.slice(2);
let phase = "unspecified";
let repository;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--phase" && args[index + 1]) phase = args[++index];
  else if (args[index] === "--repository" && args[index + 1]) repository = args[++index];
  else {
    console.error(JSON.stringify({ status: "FAIL", error: "Only --phase and --repository are accepted." }));
    process.exit(1);
  }
}
if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(phase)) {
  console.error(JSON.stringify({ status: "FAIL", error: "phase must be a short label." }));
  process.exit(1);
}
try {
  const bridge = createBridge(await loadConfig());
  const baseline = await bridge.captureBaseline({ repository });
  console.log(JSON.stringify({ phase, ...baseline }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", error: toSafeError(error) }));
  process.exitCode = 1;
}
