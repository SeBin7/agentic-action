const DEFAULTS = {
  DB_PATH: 'data/runtime_db.json',
  LOG_PATH: 'data/operations.log',
  REDDIT_SUBREDDIT: 'programming',
  HN_LIMIT: '20',
  REDDIT_LIMIT: '20',
  FETCH_TIMEOUT_MS: '10000',
  FETCH_RETRIES: '2',
  FETCH_BACKOFF_MS: '400',
  WINDOW_HOURS: '6',
  ALERT_THRESHOLD: '12',
  ALERT_COOLDOWN_HOURS: '24',
  ALERT_MIN_SCORE_DELTA: '0.5',
  ALERT_CRITICAL_MULTIPLIER: '2',
  ALERT_MIN_UNIQUE_SOURCES: '1',
  ENABLE_HN: 'true',
  ENABLE_REDDIT: 'true',
  HN_TIER: 'A',
  REDDIT_TIER: 'A',
  RATE_LIMIT_FAILURE_THRESHOLD: '3',
  SOURCE_REENABLE_ON_START: 'true'
};

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return String(value).toLowerCase() === 'true';
}

export function loadEnv({ env = process.env } = {}) {
  const merged = { ...DEFAULTS, ...env };

  return {
    githubToken: merged.GITHUB_TOKEN || '',
    discordWebhookUrl: merged.DISCORD_WEBHOOK_URL || '',
    dbPath: merged.DB_PATH,
    logPath: merged.LOG_PATH,
    redditSubreddit: merged.REDDIT_SUBREDDIT,
    hnLimit: toNumber(merged.HN_LIMIT, 20),
    redditLimit: toNumber(merged.REDDIT_LIMIT, 20),
    fetchTimeoutMs: toNumber(merged.FETCH_TIMEOUT_MS, 10000),
    fetchRetries: toNumber(merged.FETCH_RETRIES, 2),
    fetchBackoffMs: toNumber(merged.FETCH_BACKOFF_MS, 400),
    windowHours: toNumber(merged.WINDOW_HOURS, 6),
    alertThreshold: toNumber(merged.ALERT_THRESHOLD, 12),
    alertCooldownHours: toNumber(merged.ALERT_COOLDOWN_HOURS, 24),
    alertMinScoreDelta: toNumber(merged.ALERT_MIN_SCORE_DELTA, 0.5),
    alertCriticalMultiplier: toNumber(merged.ALERT_CRITICAL_MULTIPLIER, 2),
    alertMinUniqueSources: toNumber(merged.ALERT_MIN_UNIQUE_SOURCES, 1),
    enableHn: toBoolean(merged.ENABLE_HN, true),
    enableReddit: toBoolean(merged.ENABLE_REDDIT, true),
    hnTier: merged.HN_TIER,
    redditTier: merged.REDDIT_TIER,
    rateLimitFailureThreshold: toNumber(merged.RATE_LIMIT_FAILURE_THRESHOLD, 3),
    sourceReenableOnStart: toBoolean(merged.SOURCE_REENABLE_ON_START, true)
  };
}
