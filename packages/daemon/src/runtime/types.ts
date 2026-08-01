export interface RuntimeSpawnOpts {
  workdir: string;
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  env: Record<string, string | undefined>;
}

export interface RuntimeSpawnCallbacks {
  onOutput: () => void;
  onSessionId: (id: string) => Promise<void> | void;
}

export interface RuntimeHandle {
  pid: number;
  exited: Promise<number>;
  stderrText: Promise<string>;
}

export interface SessionOutputResult {
  hasOutput: boolean;
  tokenCount: number;
}

export interface RuntimeBackend {
  readonly name: string;

  spawn(opts: RuntimeSpawnOpts, callbacks: RuntimeSpawnCallbacks): Promise<RuntimeHandle>;

  sessionExists(sessionId: string): Promise<boolean>;

  getSessionOutputTokens(sessionId: string | undefined): Promise<SessionOutputResult>;
}
