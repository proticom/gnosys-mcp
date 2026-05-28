import { loadConfig } from "./config.js";
import type { GnosysResolver } from "./resolver.js";

type GetResolver = () => Promise<GnosysResolver>;

export type MaintainCommandOptions = {
  dryRun?: boolean;
  autoApply?: boolean;
};

export async function runMaintainCommand(
  getResolver: GetResolver,
  opts: MaintainCommandOptions,
): Promise<void> {
  const { GnosysMaintenanceEngine, formatMaintenanceReport } = await import("./maintenance.js");

  const resolver = await getResolver();
  const stores = resolver.getStores();

  if (stores.length === 0) {
    console.error("No Gnosys stores found. Run gnosys init first.");
    process.exit(1);
  }

  const cfg = await loadConfig(stores[0].path);

  const engine = new GnosysMaintenanceEngine(resolver, cfg);
  const report = await engine.maintain({
    dryRun: opts.dryRun,
    autoApply: opts.autoApply,
    onLog: (level, message) => {
      if (level === "warn") {
        console.error(`⚠ ${message}`);
      } else if (level === "action") {
        console.log(`→ ${message}`);
      } else {
        console.log(message);
      }
    },
    onProgress: (step, current, total) => {
      process.stdout.write(`\r[${current}/${total}] ${step}...`);
      if (current === total) process.stdout.write("\n");
    },
  });

  console.log("");
  console.log(formatMaintenanceReport(report));
}
