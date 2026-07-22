// STATUS: does NOT currently pollute opencode's stdout.
//
// Attempted to simulate omo-stable's stdout-pollution bug class
// (ework-web's stripNonJsonPreamble was added defensively in 0.1.4).
// The real omo-stable plugin emits `console.log` inside its plugin init
// flow (createCommentCheckerHooks at dist/index.js:53519 → getCommentCheckerPath
// → ensureCommentCheckerBinary → console.log at :15829/:15854/:38204/:38223).
//
// This fixture mirrors that shape: emits console.log from inside the
// opencode v1 plugin server() function. But empirically, opencode's
// plugin loader swallows even server()-emitted console.log in test env
// (mechanism not yet identified — possibly a worker-thread isolation,
// possibly stdout redirection in the loader). Top-level module-scope
// console.log is also swallowed.
//
// Kept as a marker for future investigation. When the swalling mechanism
// is understood, this fixture can be completed. Until then, regression
// coverage lives in ework-web's test/opencode.test.ts (unit-level).

const server = async () => {
  console.log("[fake-noisy] POLLUTING STDOUT from plugin server() (simulating omo-stable)");
  return { tool: {} };
};

export default { id: "fake-noisy-plugin", server };
