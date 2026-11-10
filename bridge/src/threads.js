// The thread shape orca.js hands the bridge (one thread per agent), collapsed into
// the handful of states the game shows.

const WORKING = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

export function threadStatus(t) {
  if (t.archivedAt || t.deletedAt) return 'archived';
  if (t.pendingRuntimeRequest) return 'input';
  if (t.activityRunStatus || WORKING.has(t.status)) return 'working';
  // Settled wins over an unreviewed plan: settling is how you say you're done with it.
  if (t.settledOverride === 'settled') return 'settled';
  if (t.hasActionableProposedPlan) return 'plan';
  if (t.status === 'failed' || t.lastError) return 'failed';
  return 'open';
}

export function isUnread(t) {
  const done = t.latestRunCompletedAt ? Date.parse(t.latestRunCompletedAt) : 0;
  const seen = t.lastVisitedAt ? Date.parse(t.lastVisitedAt) : 0;
  return done > seen;
}
