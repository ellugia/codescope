import { createBridge, loadConfig, toSafeError } from "../src/bridge.mjs";

try {
  const bridge = createBridge(await loadConfig());
  console.log(JSON.stringify(await bridge.doctor(), null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", error: toSafeError(error) }));
  process.exitCode = 1;
}
