#!/usr/bin/env node
import("../src/index.ts").catch((err) => {
  console.error(err);
  process.exit(1);
});
