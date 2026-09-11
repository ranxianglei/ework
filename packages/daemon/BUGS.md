# ework-daemon Bug Tracker

## Open Bugs

*(None)*

---

## Fixed Bugs

### BUG-1 + BUG-2: Completion Check + REMINDER 循环 (2026-05-31)

**Fix**: Replaced unreliable opencode-based completion check with direct model API call (`checkCompletion`). If model API configured (`COMPLETION_CHECK_API_KEY/BASE_URL/MODEL`), reads issue comment history and asks model to judge DONE/CONTINUE. Falls back to keyword heuristic. Removed REMINDER loop entirely — if opencode doesn't reply, just marks done.

### BUG-3: recover() zombie running messages (2026-05-31)

**Fix**: Already handled by existing recover logic — `getPendingOrRunningMessages()` resets all running messages to pending. Original bug was a misdiagnosis.

*(See git log for previously fixed bugs: infinite DONE loop, finishRun race, queuedAt management, etc.)*
