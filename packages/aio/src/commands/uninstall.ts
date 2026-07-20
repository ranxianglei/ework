// Uninstall: stop services, remove systemd units (if installed), preserve
// all user data. Idempotent — missing units or stale PID files are not
// errors. Data dir is never touched; user removes it manually if desired.

import { Logger } from "../log.ts";
import { resolvePaths } from "../paths.ts";
import { stopProcess } from "../pidfile.ts";
import { removeUnit, getUnitState, type SystemctlOptions } from "../systemd.ts";
import type { GlobalOptions } from "../types.ts";

export async function runUninstall(opts: GlobalOptions, logger: Logger): Promise<void> {
  const paths = resolvePaths({
    dataDir: opts.dataDir,
    scope: opts.scope,
    useSystemd: opts.useSystemd,
  });

  logger.hr();
  logger.log("uninstalling ework-aio services (keeping data)");
  logger.hr();

  // 1. Stop PID-file mode services (best-effort).
  for (const svc of ["web", "daemon"] as const) {
    const pidFile = svc === "web" ? paths.webPidFile : paths.daemonPidFile;
    try {
      const result = await stopProcess(pidFile, { graceMs: 5000, sigkillAfter: true });
      if (result.killed) {
        logger.ok(`stopped ework-${svc} (pid ${result.pid})`);
      }
    } catch (err) {
      if (err instanceof Error && /not found or empty/.test(err.message)) {
        // No PID file — service wasn't running in PID-file mode. Fine.
      } else {
        logger.warn(`stop ework-${svc} failed: ${(err as Error).message}`);
      }
    }
  }

  // 2. Remove systemd units (only if installed with --useSystemd).
  if (opts.useSystemd && paths.webUnitFile && paths.daemonUnitFile) {
    const unitOpts: SystemctlOptions = { scope: opts.scope };
    for (const svc of ["ework-web", "ework-daemon"] as const) {
      const state = getUnitState(svc, unitOpts);
      if (state === "unknown") {
        // Unit not loaded — nothing to remove.
        continue;
      }
      try {
        const unitFile = svc === "ework-web" ? paths.webUnitFile : paths.daemonUnitFile;
        await removeUnit(svc, unitFile, unitOpts);
        logger.ok(`removed ${svc}.service`);
      } catch (err) {
        logger.warn(`remove ${svc}.service failed: ${(err as Error).message}`);
      }
    }
  } else {
    logger.log("(PID-file mode — no systemd units to remove)");
  }

  // 3. Print recovery hint.
  logger.hr();
  logger.ok(`services removed. data preserved at ${paths.dataDir}`);
  logger.warn(`to fully remove: rm -rf ${paths.dataDir} && npm uninstall -g ework-aio ework-web ework-daemon opencode-ework`);
}
