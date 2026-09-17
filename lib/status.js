'use strict';

// Pure: docker.inspect() result -> meta patch, or null for "no change". Kept out of
// server.js so the reconciler's decision table is testable without a real Docker
// daemon. Only meaningful for a meta currently in starting|running — the caller is
// responsible for not calling this on an already-terminal task.
function nextStatus(inspectState) {
  if (inspectState === null) return { status: 'removed', containerName: null };
  if (inspectState.running) return null;
  if (inspectState.exitCode === 0) {
    return { status: 'completed', finishedAt: inspectState.finishedAt || new Date().toISOString(), exitCode: 0 };
  }
  return { status: 'failed', finishedAt: inspectState.finishedAt || new Date().toISOString(), exitCode: inspectState.exitCode };
}

module.exports = { nextStatus };
