#!/usr/bin/env bun
import { runServer } from "../src/index.ts";

runServer().catch((e) => {
  console.error("ework-router fatal:", e);
  process.exit(1);
});
