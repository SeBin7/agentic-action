import { loadEnv } from './config/env.js';
import { getSourceConfig } from './config/sources.js';
import { createLogger } from './utils/logger.js';
import { RuntimeRepository } from './db/repository.js';
import { collectHackerNews } from './collectors/hackernews.js';
import { collectReddit } from './collectors/reddit.js';
import { extractRepositoryMatches } from './pipeline/extract_repo.js';
import { enrichGitHubRepository } from './pipeline/enrich_github.js';
import { calculateScoreV1 } from './pipeline/score.js';
import { sendDiscordWebhook } from './notifiers/discord.js';

function buildHttpOptions(env) {
  return {
    timeoutMs: env.fetchTimeoutMs,
    retries: env.fetchRetries,
    backoffMs: env.fetchBackoffMs
  };
}

function asIsoNow(now = () => new Date()) {
  return now().toISOString();
}

function extractStatusCode(error) {
  const direct = Number(error?.status);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const matched = String(error?.message || '').match(/HTTP\s+(\d{3})/i);
  if (matched) {
    const parsed = Number(matched[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function buildAlertPayload({ repoId, score, mentionCount, uniqueSourceCount, starDelta, critical }) {
  const severity = critical ? 'CRITICAL' : 'TREND';
  return {
    content: [
      `**[${severity}] ${repoId}**`,
      `score=${score} (mentions=${mentionCount}, unique_sources=${uniqueSourceCount}, star_delta=${starDelta})`,
      `https://github.com/${repoId}`
    ].join('\n')
  };
}

export async function runPipeline({
  dryRun = false,
  envOverrides = {},
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  const env = loadEnv({ env: { ...process.env, ...envOverrides } });
  const logger = createLogger({ logPath: env.logPath, now });
  const repo = new RuntimeRepository({ dbPath: env.dbPath, logger });
  const sourceConfig = getSourceConfig(env);
  const httpOptions = buildHttpOptions(env);

  const nowIso = asIsoNow(now);
  logger.info('pipeline.start', { dryRun, nowIso });

  if (env.sourceReenableOnStart) {
    const reenabled = repo.reenableDisabledSources({ nowIso });
    if (reenabled.length > 0) {
      logger.info('source_health.reenabled', {
        count: reenabled.length,
        sources: reenabled
      });
    }
  }

  const rawEvents = [];

  if (sourceConfig.hn.enabled) {
    if (repo.isSourceDisabled('hn')) {
      logger.info('collector.hn.skipped', { reason: 'source_disabled' });
    } else {
      try {
        const hnEvents = await collectHackerNews({
          limit: env.hnLimit,
          dryRun,
          nowIso,
          httpOptions,
          logger,
          fetchImpl
        });
        rawEvents.push(...hnEvents);
        repo.recordSourceSuccess({ source: 'hn', nowIso });
      } catch (error) {
        logger.error('collector.hn.failure', { reason: error.message });
        const status = extractStatusCode(error);
        const state = repo.recordSourceFailure({
          source: 'hn',
          status,
          errorMessage: error.message,
          nowIso,
          rateLimitFailureThreshold: env.rateLimitFailureThreshold
        });
        if (state.is_disabled) {
          logger.error('collector.hn.disabled', {
            source: 'hn',
            status: state.last_status,
            consecutiveRateLimitFailures: state.consecutive_rate_limit_failures
          });
        }
      }
    }
  }

  if (sourceConfig.reddit.enabled) {
    if (repo.isSourceDisabled('reddit')) {
      logger.info('collector.reddit.skipped', { reason: 'source_disabled' });
    } else {
      try {
        const redditEvents = await collectReddit({
          subreddit: env.redditSubreddit,
          limit: env.redditLimit,
          dryRun,
          nowIso,
          httpOptions,
          logger,
          fetchImpl
        });
        rawEvents.push(...redditEvents);
        repo.recordSourceSuccess({ source: 'reddit', nowIso });
      } catch (error) {
        logger.error('collector.reddit.failure', { reason: error.message });
        const status = extractStatusCode(error);
        const state = repo.recordSourceFailure({
          source: 'reddit',
          status,
          errorMessage: error.message,
          nowIso,
          rateLimitFailureThreshold: env.rateLimitFailureThreshold
        });
        if (state.is_disabled) {
          logger.error('collector.reddit.disabled', {
            source: 'reddit',
            status: state.last_status,
            consecutiveRateLimitFailures: state.consecutive_rate_limit_failures
          });
        }
      }
    }
  }

  const extractedEvents = [];
  for (const event of rawEvents) {
    const content = `${event.text || ''} ${event.raw_url || ''}`;
    const repos = extractRepositoryMatches(content);
    for (const matched of repos) {
      extractedEvents.push({
        id: `${event.source}:${event.source_id}:${matched.repoId}`,
        source: event.source,
        repo_id: matched.repoId,
        author_id: event.author_id,
        event_ts: event.event_ts || nowIso,
        raw_url: event.raw_url,
        tier: sourceConfig[event.source]?.tier || 'A'
      });
    }
  }

  const insertedEvents = repo.insertSourceEvents(extractedEvents);
  logger.info('pipeline.extract.success', {
    rawEventCount: rawEvents.length,
    extractedEventCount: extractedEvents.length,
    insertedEvents
  });

  const repoIds = [...new Set(extractedEvents.map((event) => event.repo_id))];
  const starDeltasByRepo = new Map();

  for (const repoId of repoIds) {
    try {
      const metadata = await enrichGitHubRepository({
        repoId,
        token: env.githubToken,
        dryRun,
        nowIso,
        httpOptions,
        logger,
        fetchImpl
      });
      const upsertResult = repo.upsertRepository(metadata);
      starDeltasByRepo.set(repoId, upsertResult.starDelta);
    } catch (error) {
      logger.error('enricher.github.failure', { repoId, reason: error.message });
      starDeltasByRepo.set(repoId, 0);
    }
  }

  const windowEnd = asIsoNow(now);
  const windowStart = new Date(now().getTime() - env.windowHours * 60 * 60 * 1000).toISOString();

  for (const repoId of repoIds) {
    const events = repo.getEventsForRepoInWindow(repoId, windowStart, windowEnd);
    if (events.length === 0) {
      continue;
    }

    const mentionCount = events.length;
    const uniqueSourceCount = new Set(events.map((event) => event.source)).size;
    const tierCMentionCount = events.filter((event) => event.tier === 'C').length;
    const starDelta = starDeltasByRepo.get(repoId) || 0;

    const scoreResult = calculateScoreV1({
      mentionCount,
      uniqueSourceCount,
      starDelta,
      tierCMentionCount
    });

    repo.insertScoreSnapshot({
      repo_id: repoId,
      window_start: windowStart,
      window_end: windowEnd,
      mention_count: mentionCount,
      unique_source_count: uniqueSourceCount,
      star_delta: starDelta,
      score: scoreResult.score
    });

    logger.info('score.snapshot.created', {
      repoId,
      mentionCount,
      uniqueSourceCount,
      starDelta,
      score: scoreResult.score
    });

    const alertDecision = repo.shouldSendAlert({
      repoId,
      sentTo: 'discord',
      score: scoreResult.score,
      threshold: env.alertThreshold,
      cooldownHours: env.alertCooldownHours,
      nowIso: windowEnd
    });

    if (!alertDecision.shouldSend) {
      logger.info('alert.skipped', {
        repoId,
        reason: alertDecision.reason,
        score: scoreResult.score
      });
      continue;
    }

    try {
      const payload = buildAlertPayload({
        repoId,
        score: scoreResult.score,
        mentionCount,
        uniqueSourceCount,
        starDelta,
        critical: alertDecision.critical
      });
      const sent = await sendDiscordWebhook({
        webhookUrl: env.discordWebhookUrl,
        payload,
        dryRun,
        httpOptions,
        logger,
        fetchImpl
      });

      if (sent.sent) {
        repo.insertAlert({
          repoId,
          score: scoreResult.score,
          sentTo: 'discord',
          sentAtIso: windowEnd,
          isCritical: alertDecision.critical
        });
      }
    } catch (error) {
      logger.error('alert.failure', {
        repoId,
        reason: error.message
      });
    }
  }

  logger.info('pipeline.complete', {
    rawEventCount: rawEvents.length,
    extractedEventCount: extractedEvents.length,
    repoCount: repoIds.length
  });

  return {
    rawEventCount: rawEvents.length,
    extractedEventCount: extractedEvents.length,
    repoCount: repoIds.length,
    insertedEvents
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await runPipeline({ dryRun });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
