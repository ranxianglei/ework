// Pretty-printer for install / CLI output. Mirrors the bash aesthetic from
// bin/install.sh (• for log, ✓ for ok, ! for warn, ✗ for die, ── for hr)
// but with TS types and injectable stream so tests can capture output.

const isTTY = process.stdout.isTTY ?? false;

// Minimal stream interface — narrower than the full WriteStream type so
// stdout (fd 1) and stderr (fd 2) are both assignable without friction.
interface WritableStreamLike {
  write(chunk: string | Uint8Array): boolean;
  isTTY?: boolean;
}

function colorEnabled(stream: WritableStreamLike): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return stream.isTTY ?? false;
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
} as const;

export interface LoggerOptions {
  stdout?: WritableStreamLike;
  stderr?: WritableStreamLike;
}

export class Logger {
  private readonly stdout: WritableStreamLike;
  private readonly stderr: WritableStreamLike;
  private readonly stdoutColor: boolean;
  private readonly stderrColor: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
    this.stdoutColor = colorEnabled(this.stdout);
    this.stderrColor = colorEnabled(this.stderr);
  }

  private paint(stream: WritableStreamLike, enabled: boolean, ...parts: Array<string>): string {
    return parts.map((p) => (enabled ? p : p.replace(/\x1b\[[0-9;]*m/g, ""))).join("");
  }

  log(msg: string): void {
    const line = this.paint(this.stdout, this.stdoutColor, `${C.blue}•${C.reset} `, msg, "\n");
    this.stdout.write(line);
  }

  ok(msg: string): void {
    const line = this.paint(this.stdout, this.stdoutColor, `${C.green}✓${C.reset} `, msg, "\n");
    this.stdout.write(line);
  }

  warn(msg: string): void {
    const line = this.paint(this.stderr, this.stderrColor, `${C.yellow}!${C.reset} `, msg, "\n");
    this.stderr.write(line);
  }

  error(msg: string): void {
    const line = this.paint(this.stderr, this.stderrColor, `${C.red}✗${C.reset} `, msg, "\n");
    this.stderr.write(line);
  }

  hr(): void {
    const line = this.paint(this.stdout, this.stdoutColor, `${C.dim}──${C.reset}`, "\n");
    this.stdout.write(line);
  }

  bold(msg: string): string {
    return this.paint(this.stdout, this.stdoutColor, `${C.bold}${msg}${C.reset}`);
  }

  dim(msg: string): string {
    return this.paint(this.stdout, this.stdoutColor, `${C.dim}${msg}${C.reset}`);
  }

  die(msg: string, code: number = 1): never {
    this.error(msg);
    process.exit(code);
  }
}

export const log = new Logger();

// InstallError: typed fatal for install flow. Distinct from generic Error so
// catch sites can tell "expected install failure" from "unexpected crash".
export class InstallError extends Error {
  readonly code: number;
  constructor(message: string, code: number = 1) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}
