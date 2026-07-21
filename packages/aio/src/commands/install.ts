// Install orchestrator. Wires together every module that Phase 1+2 produced
// into the end-to-end flow:
//   preflight → resolvePaths → mkdir → ensureEnvFile(web) → startProcess(web)
//   → pollWebUp → bootstrap bot user + PAT → save bot-token file
//   → patch daemon .env with PAT → ensureEnvFile(daemon) → ensurePluginInFile
//   → startProcess(daemon) → summary printout
//
// The flow is the TS port of bin/install.sh. Where install.sh used curl,
// openssl, jq, awk, here we use fetch, node:crypto, JSON.parse, and the
// typed helpers in src/env.ts.
//
// Idempotence contract (sacred — same as install.sh):
//   - Existing .env is preserved; only missing required keys are appended.
//   - bot-token file is reused if present (no second PAT minted).
//   - opencode.json unknown keys are preserved by opencode-config.ts.
//   - Re-running install never destroys user data.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { Logger, InstallError } from "../log.ts";
import { resolvePaths, type PathConfig } from "../paths.ts";
import { type InstallContext } from "../config.ts";
import { ensureEnvFile, parseEnvFile, patchEnvKey } from "../env.ts";
import { startProcess, isProcessRunning, readPidFile } from "../pidfile.ts";
import { checkPreflight, resolveCommand, REQUIRED_COMMANDS } from "../preflight.ts";
import {
  generateUnitFile,
  writeUnitFile,
  installUnit,
  startUnit,
  disableUnit,
  type SystemctlOptions,
} from "../systemd.ts";
import { ensurePluginInFile } from "../opencode-config.ts";
import type { GlobalOptions } from "../types.ts";
import { DEFAULTS } from "../types.ts";

export interface InstallOutcome {
  mode: "pidfile" | "systemd";
  webStarted: boolean;
  daemonStarted: boolean;
  botBootstrapped: boolean;
  paths: PathConfig;
  workPort: number;
  botName: string;
  botToken: string;
  operatorLogin: string;
  workToken: string;
}

const PLUGIN_NAME = "opencode-ework@latest";
const BOT_TOKEN_FILENAME = "bot-token";

// Minimal callable fetch signature — narrower than Bun's `typeof fetch`
// (which adds preconnect etc.) so test mocks can pass plain functions.
type FetchLike = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

export interface InstallHooks {
  // Overridable fetch (for tests).
  fetchImpl?: FetchLike;
  // Overridable file-existence check (for tests).
  exists?: (p: string) => boolean;
}

export async function runInstall(
  opts: GlobalOptions,
  logger: Logger,
  hooks: InstallHooks = {},
): Promise<InstallOutcome> {
  const exists = hooks.exists ?? ((p) => fs.existsSync(p));
  // S-4: process.env.USER is settable by the caller and sudo variants
  // propagate it inconsistently (sudo -i keeps the original, plain sudo
  // resets it). os.userInfo().username reads from the password database
  // via the getpwuid syscall — the only authoritative source for "who am
  // I running as right now".
  const operatorLogin = os.userInfo().username;

  logger.hr();
  logger.log("ework-aio install");
  logger.log(`  mode       : ${opts.useSystemd ? "systemd" : "PID-file (no systemd)"}`);
  logger.log(`  data dir   : ${opts.dataDir ?? "(default ~/.local/share/ework-aio)"}`);
  logger.hr();

  // 1. Preflight: bun/npm/opencode must exist on PATH.
  const preflight = checkPreflight([...REQUIRED_COMMANDS], {
    optionalCommands: ["systemctl"],
  });
  if (preflight.missing.length > 0) {
    throw new InstallError(
      `Missing required commands on PATH: ${preflight.missing.join(", ")}. ` +
      `Install them and re-run ework-aio install.`,
    );
  }
  const opencodeBin = preflight.found.get("opencode")!;
  logger.ok(`preflight: bun, npm, opencode all on PATH`);

  // 2. Resolve ework-web / ework-daemon binaries (npm-installed global bins).
  const webBin = resolveCommand("ework-web");
  const daemonBin = resolveCommand("ework-daemon");
  if (!webBin) {
    throw new InstallError(
      `ework-web binary not found on PATH. Install with: npm install -g ework-web`,
    );
  }
  if (!daemonBin) {
    throw new InstallError(
      `ework-daemon binary not found on PATH. Install with: npm install -g ework-daemon`,
    );
  }
  logger.ok(`web bin    : ${webBin}`);
  logger.ok(`daemon bin : ${daemonBin}`);

  // 3. Resolve all filesystem paths.
  const paths = resolvePaths({
    dataDir: opts.dataDir,
    scope: opts.scope,
    useSystemd: opts.useSystemd,
  });

  // 4. Ensure data directories exist.
  for (const dir of [
    paths.dataDir,
    paths.webDataDir,
    paths.daemonDataDir,
    paths.runDir,
    paths.opencodeWorkdir,
    paths.webAttachmentRoot,
  ]) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  // 5. Write (or forward-fill) web .env.
  const ctx: InstallContext = {
    paths,
    workPort: opts.workPort,
    daemonPort: opts.daemonPort,
    botName: opts.botName,
    operatorLogin,
    opencodeBin,
  };
  const webEnvResult = await ensureEnvFile({ file: "web", filePath: paths.webEnvFile, ctx });
  if (webEnvResult.created) {
    logger.ok(`wrote ${paths.webEnvFile}`);
  } else if (webEnvResult.added.length > 0) {
    logger.ok(`forward-filled ${paths.webEnvFile}: +${webEnvResult.added.length} keys (${webEnvResult.added.join(", ")})`);
  } else {
    logger.ok(`web .env up to date`);
  }

  // B-4: --port / --daemon-port only apply to FRESH installs (forward-fill
  // never overwrites). If the user passed --port but .env already has a
  // different WORK_PORT, warn — the value didn't take effect. Use
  // `config set WORK_PORT <N>` to change a running install's port.
  if (!webEnvResult.created) {
    const existingWorkPort = await readEnvKey(paths.webEnvFile, "WORK_PORT");
    if (existingWorkPort && parseInt(existingWorkPort, 10) !== opts.workPort) {
      logger.warn(
        `--port ${opts.workPort} ignored: existing .env has WORK_PORT=${existingWorkPort}. ` +
        `Use 'ework-aio config set WORK_PORT ${opts.workPort}' to change it.`,
      );
    }
    const existingDaemonPort = await readEnvKey(paths.daemonEnvFile, "DAEMON_PORT");
    if (existingDaemonPort && parseInt(existingDaemonPort, 10) !== opts.daemonPort) {
      logger.warn(
        `--daemon-port ${opts.daemonPort} ignored: existing .env has DAEMON_PORT=${existingDaemonPort}. ` +
        `Use 'ework-aio config set DAEMON_PORT ${opts.daemonPort}' to change it.`,
      );
    }
  }

  // 6. (Systemd only) Write unit, daemon-reload, enable.
  let systemdOk = false;
  if (opts.useSystemd && paths.webUnitFile) {
    const unitOpts: SystemctlOptions = { scope: opts.scope };
    const userInfo = os.userInfo();
    const webUnit = generateUnitFile("ework-web", {
      user: userInfo.username,
      group: userInfo.username,
      binPath: preflight.found.get("bun")!,
      mainScript: webBin,
      envFile: paths.webEnvFile,
      workingDirectory: paths.webDataDir,
      logFile: paths.webLogFile,
      scope: opts.scope,
    });
    await writeUnitFile(paths.webUnitFile, webUnit);
    logger.ok(`wrote ${paths.webUnitFile}`);
    try {
      await installUnit("ework-web", paths.webUnitFile, webUnit, unitOpts);
      systemdOk = true;
      // S-1: enable linger so user-scope units survive logout. Without
      // this, `install systemd --user` produces units that die when the
      // user logs out — defeating the point of systemd mode. Best-effort.
      if (opts.scope === "user") {
        const linger = Bun.spawnSync(["loginctl", "enable-linger", userInfo.username], {
          env: process.env,
          stdout: "pipe", stderr: "pipe",
        });
        if (linger.exitCode === 0) {
          logger.ok(`enabled linger for ${userInfo.username} (user units survive logout)`);
        } else {
          logger.warn(
            `could not enable linger for ${userInfo.username}: ${linger.stderr?.toString().trim() ?? ""}. ` +
            `Run 'sudo loginctl enable-linger ${userInfo.username}' so user units survive logout.`,
          );
        }
      }
    } catch (err) {
      logger.warn(`systemd install failed for ework-web: ${(err as Error).message}`);
      logger.warn(`falling back to PID-file mode for ework-web`);
      systemdOk = false;
    }
  }

  // 7. Start ework-web (PID-file mode, unless systemd already brought it up).
  // --no-start skips service startup entirely; .env is written but the user
  // runs `ework-aio start` themselves later. Bot bootstrap is also skipped
  // (web isn't reachable).
  let webStarted = false;
  const webPidExisting = await readPidFile(paths.webPidFile);
  if (webPidExisting !== null && isProcessRunning(webPidExisting)) {
    webStarted = true;
    logger.log(`ework-web already running (pid ${webPidExisting})`);
  }
  if (!webStarted && opts.noStart) {
    logger.warn(`--no-start: skipping ework-web startup (write .env only)`);
  } else if (!webStarted && systemdOk) {
    try {
      await startUnit("ework-web", { scope: opts.scope });
      webStarted = true;
      systemdOk = true;
      logger.ok(`started ework-web via systemd`);
    } catch (err) {
      logger.warn(`systemd start failed: ${(err as Error).message}`);
      logger.warn(`disabling ework-web unit and falling back to PID-file mode`);
      // Disable the already-enabled unit so it doesn't auto-start on next
      // boot and fight the PID-file mode process for the port.
      try {
        await disableUnit("ework-web", { scope: opts.scope });
      } catch (disableErr) {
        logger.warn(`could not disable ework-web unit: ${(disableErr as Error).message}`);
      }
      systemdOk = false;
    }
  }
  if (!webStarted && !opts.noStart) {
    logger.log(`starting ework-web (PID-file mode)...`);
    const env = await loadEnvIntoProcess(paths.webEnvFile);
    const { pid } = await startProcess({
      cmd: webBin,
      args: [],
      cwd: paths.webDataDir,
      env,
      logFile: paths.webLogFile,
      pidFile: paths.webPidFile,
    });
    logger.ok(`ework-web started (pid ${pid}, log ${paths.webLogFile})`);
    webStarted = true;
  }

  // 8. Wait for ework-web to answer on its HTTP port. Skipped under --no-start.
  // S-3: read WORK_PORT from the actual .env rather than opts.workPort.
  // On a re-install where the user previously ran `config set WORK_PORT 8080`
  // and didn't pass --port this time, opts.workPort is the default (3002)
  // but the running service listens on 8080. Polling the wrong port times
  // out at 30s every re-install — a confusing UX with no error hint.
  const actualWorkPortStr = await readEnvKey(paths.webEnvFile, "WORK_PORT");
  const actualWorkPort = actualWorkPortStr && /^\d+$/.test(actualWorkPortStr)
    ? parseInt(actualWorkPortStr, 10)
    : opts.workPort;
  const baseUrl = `http://127.0.0.1:${actualWorkPort}`;
  if (webStarted) {
    try {
      await pollHttpUp(baseUrl + "/login", hooks.fetchImpl);
      logger.ok(`ework-web listening on :${actualWorkPort}`);
    } catch (err) {
      if (!opts.noStart) throw err;
      logger.warn(`ework-web not reachable (start failed under --no-start): ${(err as Error).message}`);
    }
  }

  // 9. Bootstrap bot user + PAT (idempotent — reuse saved token if present).
  // Skipped under --no-start (no point — web isn't reachable to drive the API).
  // botTokenFile is per-botName so changing --bot-name invalidates the cache
  // (otherwise we'd reuse a PAT minted for a different bot user).
  const workToken = await readEnvKey(paths.webEnvFile, "WORK_TOKEN");
  const cookieSecret = await readEnvKey(paths.webEnvFile, "WORK_COOKIE_SECRET");
  if (!workToken || !cookieSecret) {
    throw new InstallError(
      `web .env missing WORK_TOKEN or WORK_COOKIE_SECRET — refusing to bootstrap`,
    );
  }

  const botTokenFile = opts.botName === DEFAULTS.botName
    ? paths.botTokenFile
    : `${paths.botTokenFile}.${opts.botName}`;
  let botToken = "";
  let botBootstrapped = false;
  let bootstrapFailed = false;
  if (webStarted && exists(botTokenFile)) {
    botToken = (await fs.promises.readFile(botTokenFile, "utf8")).trim();
    if (botToken) {
      logger.ok(`reusing saved bot token from ${botTokenFile}`);
      botBootstrapped = true;
    }
  }
  if (webStarted && !botBootstrapped) {
    try {
      botToken = await bootstrapBot({
        baseUrl,
        adminCookie: buildAuthCookie(workToken, cookieSecret),
        botLogin: opts.botName,
        fetchImpl: hooks.fetchImpl,
      });
      await fs.promises.writeFile(botTokenFile, botToken, { mode: 0o600 });
      logger.ok(`bot PAT saved to ${botTokenFile}`);
      botBootstrapped = true;
    } catch (err) {
      // B-5: surface this as a real failure, not just a warn. The daemon
      // would silently fail every authenticated call otherwise.
      logger.error(`bot bootstrap failed: ${(err as Error).message}`);
      logger.error(`daemon .env will have empty BOT_TOKEN — re-run install to retry`);
      bootstrapFailed = true;
    }
  } else if (!webStarted) {
    logger.warn(`--no-start: skipping bot bootstrap (web not running)`);
  }

  // 10. Write daemon .env (forward-fill, includes BOT_TOKEN if known).
  // The daemon .env's BOT_TOKEN slot is regenerated empty by config.ts; we
  // patch it post-forward-fill with the bootstrap result.
  const daemonEnvResult = await ensureEnvFile({ file: "daemon", filePath: paths.daemonEnvFile, ctx });
  if (daemonEnvResult.created) {
    logger.ok(`wrote ${paths.daemonEnvFile}`);
  } else if (daemonEnvResult.added.length > 0) {
    logger.ok(`forward-filled ${paths.daemonEnvFile}: +${daemonEnvResult.added.length} keys`);
  }
  if (botToken) {
    await patchEnvKey(paths.daemonEnvFile, "BOT_TOKEN", botToken);
    await patchEnvKey(paths.daemonEnvFile, "GITEA_TOKEN", botToken);
  }

  // 11. (Systemd only) Write + install daemon unit.
  if (opts.useSystemd && paths.daemonUnitFile && systemdOk && !opts.noStart) {
    const userInfo = os.userInfo();
    const unit = generateUnitFile("ework-daemon", {
      user: userInfo.username,
      group: userInfo.username,
      binPath: preflight.found.get("bun")!,
      mainScript: daemonBin,
      envFile: paths.daemonEnvFile,
      workingDirectory: paths.daemonDataDir,
      logFile: paths.daemonLogFile,
      scope: opts.scope,
    });
    await writeUnitFile(paths.daemonUnitFile, unit);
    logger.ok(`wrote ${paths.daemonUnitFile}`);
    try {
      await installUnit("ework-daemon", paths.daemonUnitFile, unit, { scope: opts.scope });
      await startUnit("ework-daemon", { scope: opts.scope });
      logger.ok(`started ework-daemon via systemd`);
    } catch (err) {
      logger.warn(`daemon systemd start failed: ${(err as Error).message}`);
      logger.warn(`disabling ework-daemon unit and falling back to PID-file mode`);
      try {
        await disableUnit("ework-daemon", { scope: opts.scope });
      } catch (disableErr) {
        logger.warn(`could not disable ework-daemon unit: ${(disableErr as Error).message}`);
      }
      systemdOk = false;
    }
  }

  // 12. Start ework-daemon (PID-file mode if systemd didn't bring it up).
  // Skipped under --no-start.
  let daemonStarted = false;
  if (opts.noStart) {
    logger.warn(`--no-start: skipping ework-daemon startup`);
  } else {
    const daemonPid = await readPidFile(paths.daemonPidFile);
    if (daemonPid !== null && isProcessRunning(daemonPid)) {
      daemonStarted = true;
      logger.log(`ework-daemon already running (pid ${daemonPid})`);
    }
    if (!daemonStarted) {
      logger.log(`starting ework-daemon (PID-file mode)...`);
      const env = await loadEnvIntoProcess(paths.daemonEnvFile);
      const { pid } = await startProcess({
        cmd: daemonBin,
        args: [],
        cwd: paths.daemonDataDir,
        env,
        logFile: paths.daemonLogFile,
        pidFile: paths.daemonPidFile,
      });
      logger.ok(`ework-daemon started (pid ${pid}, log ${paths.daemonLogFile})`);
      daemonStarted = true;
    }
  }

  // 13. Register opencode-ework plugin in opencode.json (idempotent).
  const { added: pluginAdded } = await ensurePluginInFile(paths.opencodeConfigFile, PLUGIN_NAME);
  if (pluginAdded) {
    logger.ok(`registered ${PLUGIN_NAME} in ${paths.opencodeConfigFile}`);
  } else {
    logger.ok(`opencode.json already has ${PLUGIN_NAME}`);
  }

  // 14. Print summary.
  printSummary(logger, {
    mode: opts.useSystemd && systemdOk ? "systemd" : "pidfile",
    webStarted,
    daemonStarted,
    botBootstrapped,
    paths,
    workPort: opts.workPort,
    botName: opts.botName,
    botToken,
    operatorLogin,
    workToken,
  });

  // B-5: bootstrap failure must not masquerade as success. Throw a typed
  // error so cli.ts main() exits non-zero and the user knows to re-run.
  if (bootstrapFailed) {
    throw new InstallError(
      `install completed with degraded state: bot bootstrap failed. ` +
      `Services may have started but the daemon will not authenticate. ` +
      `Re-run 'ework-aio install' to retry.`,
      2,
    );
  }

  return {
    mode: opts.useSystemd && systemdOk ? "systemd" : "pidfile",
    webStarted,
    daemonStarted,
    botBootstrapped,
    paths,
    workPort: opts.workPort,
    botName: opts.botName,
    botToken,
    operatorLogin,
    workToken,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function pollHttpUp(url: string, fetchImpl?: FetchLike): Promise<void> {
  const fetchFn = fetchImpl ?? fetch;
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const r = await fetchFn(url, { method: "GET" });
      if (r.status < 500) return;
    } catch {
      // Network error — retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new InstallError(`service did not come up at ${url} after 60 attempts (30s)`);
}

// buildAuthCookie: construct the ework_auth cookie value the way ework-web
// expects: `<token>.<base64url(hmac_sha256(token, secret))>` — the same
// recipe install.sh used with openssl.
export function buildAuthCookie(token: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(token).digest();
  const b64url = sig.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `ework_auth=${token}.${b64url}`;
}

async function readEnvKey(envFile: string, key: string): Promise<string | null> {
  try {
    const content = await Bun.file(envFile).text();
    const parsed = parseEnvFile(content);
    const v = parsed.entries.get(key);
    return v !== undefined ? v : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// loadEnvIntoProcess: read .env into a fresh object suitable for spawn env.
// Inherits process.env (so PATH etc. are available) and overlays .env keys.
async function loadEnvIntoProcess(envFile: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const content = await Bun.file(envFile).text();
    const parsed = parseEnvFile(content);
    for (const [k, v] of parsed.entries) env[k] = v;
  } catch {
    // Missing .env is fine — fall back to process.env only.
  }
  return env;
}

interface BootstrapBotOpts {
  baseUrl: string;
  adminCookie: string;
  botLogin: string;
  fetchImpl?: FetchLike;
}

// bootstrapBot: faithful port of install.sh's bot user + PAT flow.
// Uses the operator's token-derived cookie to drive ework-web's admin API,
// then logs in as the bot to mint a PAT. Step-by-step idempotence:
//   - create user: HTTP 303 = created, 400/409 = already exists (continue)
//   - login as bot: required to get a session cookie for /me/tokens/create
//   - mint PAT: scrape the token out of the HTML response (the only way
//     ework-web exposes clear-text tokens, matching install.sh)
async function bootstrapBot(opts: BootstrapBotOpts): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const botPassword = randomBytes(24).toString("hex");

  // 1. Create bot user via admin API.
  const createRes = await fetchImpl(`${opts.baseUrl}/admin/users/create`, {
    method: "POST",
    headers: { Cookie: opts.adminCookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      login: opts.botLogin,
      password: botPassword,
      kind: "bot",
      is_admin: "0",
    }).toString(),
    redirect: "manual",
  });
  // 303 = created, 400/409 = already exists. Anything else = abort.
  if (![303, 400, 409].includes(createRes.status)) {
    const body = await createRes.text();
    throw new InstallError(`create bot user failed (HTTP ${createRes.status}): ${body.slice(0, 200)}`);
  }

  // 2. Login as bot to get its session cookie.
  const loginRes = await fetchImpl(`${opts.baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      login: opts.botLogin,
      password: botPassword,
    }).toString(),
    redirect: "manual",
  });
  if (loginRes.status !== 302) {
    const body = await loginRes.text();
    throw new InstallError(`bot login failed (HTTP ${loginRes.status}): ${body.slice(0, 200)}`);
  }
  const setCookie = loginRes.headers.get("set-cookie");
  const botCookie = parseFirstCookie(loginRes.headers);
  if (!botCookie) {
    throw new InstallError(`bot login response missing ework_auth cookie (set-cookie: ${setCookie ?? "<absent>"})`);
  }

  // 3. Mint PAT via /me/tokens/create. Response is HTML containing the
  // clear-text token in `<input id="t" value="<40-hex>">`. We only get one
  // chance to see the clear-text — must scrape it now.
  //
  // S-3: pin redirect:"manual" so a PRG-style 303→GET doesn't land us on
  // a "token list" page where the clear-text value isn't present.
  //
  // S-2: scrape regex is attribute-order-independent — accepts both
  // `<input id="t" value="...">` and `<input value="..." id="t">`.
  const patRes = await fetchImpl(`${opts.baseUrl}/me/tokens/create`, {
    method: "POST",
    headers: { Cookie: botCookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: `aio-${Date.now()}` }).toString(),
    redirect: "manual",
  });
  if (patRes.status !== 200) {
    throw new InstallError(
      `mint PAT returned HTTP ${patRes.status} (expected 200 with HTML body)`,
    );
  }
  const patBody = await patRes.text();
  // S-2: scrape regex is attribute-order-independent — accepts both
  // `<input id="t" value="...">` and `<input value="..." id="t">`.
  // Case-insensitive (i flag) so XHTML-style `<INPUT VALUE="...">` from
  // ework-web template tweaks doesn't silently break scraping.
  const match = patBody.match(/<input[^>]*id="t"[^>]*value="([a-f0-9]{40})"/i)
    ?? patBody.match(/<input[^>]*value="([a-f0-9]{40})"[^>]*id="t"/i);
  if (!match || !match[1]) {
    throw new InstallError(`could not extract PAT from token-create response`);
  }
  return match[1];
}

function parseFirstCookie(headers: Headers): string | null {
  // S-7: Headers#getSetCookie returns each Set-Cookie as a separate entry.
  // Falling back to parsing the combined "set-cookie" header is fragile —
  // multiple cookies get joined with ", " and individual cookies contain
  // commas in attribute values (`Expires=Wed, 09 Jun 2021 ...`). The
  // regex split looks for ", " followed by a name=value pattern.
  const getSetCookies = (headers as unknown as {
    getSetCookie?: () => string[];
  }).getSetCookie;
  const allCookies: string[] = [];
  if (typeof getSetCookies === "function") {
    allCookies.push(...getSetCookies.call(headers));
  } else {
    const sc = headers.get("set-cookie");
    if (sc) allCookies.push(...sc.split(/,(?=\s*[\w-]+=)/));
  }
  for (const c of allCookies) {
    const kv = c.split(";")[0]?.trim() ?? "";
    if (kv.startsWith("ework_auth=")) return kv;
  }
  return null;
}

function printSummary(logger: Logger, o: InstallOutcome): void {
  logger.hr();
  logger.ok(`install complete (${o.mode} mode)`);
  logger.hr();
  logger.log(`  → open http://127.0.0.1:${o.workPort}/login`);
  logger.log(`  operator login : ${o.operatorLogin} (auto-promoted admin)`);
  // S-8: only print the token when stdout is a TTY. Piping install output
  // to a file or shell variable (e.g. `logs=$(ework-aio install 2>&1)`)
  // would otherwise leak the admin credential into logs.
  if (process.stdout.isTTY) {
    logger.log(`  login token    : ${o.workToken}`);
  } else {
    logger.log(`  login token    : (hidden — read from ${o.paths.webEnvFile})`);
  }
  logger.log(`  bot user       : ${o.botName} (auto-created)`);
  logger.log(`  data dir       : ${o.paths.dataDir}`);
  logger.log(`  logs           : ework-aio logs web | ework-aio logs daemon`);
  logger.log(`  status         : ework-aio status`);
  logger.log(`  stop           : ework-aio stop`);
  logger.log(`  uninstall      : ework-aio uninstall`);
  if (o.mode === "pidfile") {
    logger.hr();
    logger.log(`  PID-file mode (services run detached, no systemd supervisor)`);
    logger.log(`  • auto-restart on boot: re-run with 'ework-aio install systemd'`);
    logger.log(`  • services stop on kill; use 'ework-aio stop' for clean shutdown`);
  }
  logger.hr();
}
