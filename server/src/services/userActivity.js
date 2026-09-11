const ACTIVITY_KEY_PREFIX = 'qlicker:activity';
const PUBLISH_THROTTLE_MS = 60 * 1000;
const KEY_TTL_SECONDS = 8 * 24 * 60 * 60;
const FLUSH_INTERVAL_MS = 100;
const MAX_PENDING_USERS = 1_000;

export function getActiveUserRedisKey(role = 'all') {
  return `${ACTIVITY_KEY_PREFIX}:${role}`;
}

export function registerUserActivityTracking(app, options = {}) {
  const lastPublishedAt = new Map();
  const now = options.now || (() => Date.now());
  const publishThrottleMs = options.publishThrottleMs ?? PUBLISH_THROTTLE_MS;
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const maxPendingUsers = options.maxPendingUsers ?? MAX_PENDING_USERS;
  let lastSweepAt = 0;
  let pendingUsers = new Map();
  let flushTimer = null;
  let flushInFlight = false;
  let closing = false;

  function scheduleFlush() {
    if (closing || flushTimer || flushInFlight || pendingUsers.size === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushPendingActivity();
    }, flushIntervalMs);
    flushTimer.unref?.();
  }

  async function flushPendingActivity() {
    if (closing || flushInFlight || pendingUsers.size === 0) return;
    if (!app.redis || (app.redis.status && app.redis.status !== 'ready')) {
      pendingUsers.clear();
      return;
    }

    const batch = pendingUsers;
    pendingUsers = new Map();
    flushInFlight = true;
    try {
      const membersByRole = new Map();
      for (const [userId, entry] of batch) {
        for (const role of ['all', ...entry.roles]) {
          if (!membersByRole.has(role)) membersByRole.set(role, []);
          membersByRole.get(role).push(entry.timestamp, userId);
        }
      }

      const pipeline = app.redis.pipeline();
      for (const [role, members] of membersByRole) {
        const key = getActiveUserRedisKey(role);
        pipeline.zadd(key, ...members);
        pipeline.expire(key, KEY_TTL_SECONDS);
      }
      await pipeline.exec();
    } catch (error) {
      app.log.debug({ err: error }, 'Unable to publish active-user heartbeat');
    } finally {
      flushInFlight = false;
      scheduleFlush();
    }
  }

  function recordAuthenticatedActivity(user = {}) {
    const userId = String(user.userId || '').trim();
    // Never queue monitoring writes during a Redis outage.
    if (!userId || !app.redis
      || (app.redis.status && app.redis.status !== 'ready')) return;

    const timestamp = now();
    const previous = lastPublishedAt.get(userId) || 0;
    if (timestamp - previous < publishThrottleMs) return;
    if (!pendingUsers.has(userId) && pendingUsers.size >= maxPendingUsers) return;

    const roles = [...new Set((user.roles || [])
      .map((role) => String(role || '').trim().toLowerCase())
      .filter((role) => ['student', 'professor', 'admin'].includes(role)))];
    lastPublishedAt.set(userId, timestamp);
    pendingUsers.set(userId, { timestamp, roles });
    scheduleFlush();

    if (timestamp - lastSweepAt >= publishThrottleMs) {
      lastSweepAt = timestamp;
      const cutoff = timestamp - publishThrottleMs;
      for (const [trackedUserId, trackedAt] of lastPublishedAt) {
        if (trackedAt <= cutoff) lastPublishedAt.delete(trackedUserId);
      }
    }
    // Bound memory even during sustained traffic from many distinct users.
    if (lastPublishedAt.size > 20_000) lastPublishedAt.delete(lastPublishedAt.keys().next().value);
  }

  app.decorate('recordAuthenticatedActivity', recordAuthenticatedActivity);
  app.addHook('onClose', async () => {
    closing = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    pendingUsers.clear();
    lastPublishedAt.clear();
  });
  return { flushPendingActivity };
}
