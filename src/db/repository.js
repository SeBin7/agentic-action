import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE_LIMIT_STATUSES = new Set([403, 429]);
const DEFAULT_RATE_LIMIT_FAILURE_THRESHOLD = 3;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function toEpoch(value) {
  return new Date(value).getTime();
}

export class RuntimeRepository {
  constructor({ dbPath, logger, schemaPath = DEFAULT_SCHEMA_PATH }) {
    this.dbPath = dbPath;
    this.logger = logger;
    this.schemaPath = schemaPath;
    this.db = this.#openDatabase();
    this.statements = this.#prepareStatements();
  }

  #openDatabase() {
    mkdirSync(path.dirname(this.dbPath), { recursive: true });

    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    try {
      const schemaSql = readFileSync(this.schemaPath, 'utf8');
      db.exec(schemaSql);
    } catch (error) {
      this.logger?.error('db.schema.failure', {
        dbPath: this.dbPath,
        schemaPath: this.schemaPath,
        reason: error.message
      });
      throw error;
    }

    return db;
  }

  #prepareStatements() {
    return {
      insertSourceEvent: this.db.prepare(`
        INSERT OR IGNORE INTO source_events (
          id,
          source,
          repo_id,
          author_id,
          event_ts,
          raw_url,
          tier
        ) VALUES (
          @id,
          @source,
          @repo_id,
          @author_id,
          @event_ts,
          @raw_url,
          @tier
        )
      `),
      getRepository: this.db.prepare(`
        SELECT
          repo_id,
          repo_url,
          created_at,
          stars,
          last_seen_at
        FROM repositories
        WHERE repo_id = ?
      `),
      upsertRepository: this.db.prepare(`
        INSERT INTO repositories (
          repo_id,
          repo_url,
          created_at,
          stars,
          last_seen_at
        ) VALUES (
          @repo_id,
          @repo_url,
          @created_at,
          @stars,
          @last_seen_at
        )
        ON CONFLICT(repo_id) DO UPDATE SET
          repo_url = excluded.repo_url,
          created_at = excluded.created_at,
          stars = excluded.stars,
          last_seen_at = excluded.last_seen_at
      `),
      getEventsForRepoInWindow: this.db.prepare(`
        SELECT
          id,
          source,
          repo_id,
          author_id,
          event_ts,
          raw_url,
          tier
        FROM source_events
        WHERE repo_id = ?
          AND event_ts >= ?
          AND event_ts <= ?
        ORDER BY event_ts ASC
      `),
      upsertScoreSnapshot: this.db.prepare(`
        INSERT INTO repo_score_snapshots (
          repo_id,
          window_start,
          window_end,
          mention_count,
          unique_source_count,
          star_delta,
          score
        ) VALUES (
          @repo_id,
          @window_start,
          @window_end,
          @mention_count,
          @unique_source_count,
          @star_delta,
          @score
        )
        ON CONFLICT(repo_id, window_end) DO UPDATE SET
          window_start = excluded.window_start,
          mention_count = excluded.mention_count,
          unique_source_count = excluded.unique_source_count,
          star_delta = excluded.star_delta,
          score = excluded.score
      `),
      listTopReposByLatestSnapshotInWindow: this.db.prepare(`
        SELECT
          s.repo_id,
          s.score,
          s.mention_count,
          s.unique_source_count,
          s.star_delta,
          s.window_end
        FROM repo_score_snapshots s
        INNER JOIN (
          SELECT
            repo_id,
            MAX(window_end) AS max_window_end
          FROM repo_score_snapshots
          WHERE window_end >= @window_start
          GROUP BY repo_id
        ) latest
          ON latest.repo_id = s.repo_id
         AND latest.max_window_end = s.window_end
        ORDER BY s.score DESC, s.mention_count DESC, s.repo_id ASC
        LIMIT @limit
      `),
      getLatestAlert: this.db.prepare(`
        SELECT
          id,
          repo_id,
          score,
          sent_to,
          sent_at,
          is_critical
        FROM alerts_sent
        WHERE repo_id = ?
          AND sent_to = ?
        ORDER BY sent_at DESC
        LIMIT 1
      `),
      insertAlert: this.db.prepare(`
        INSERT INTO alerts_sent (
          repo_id,
          score,
          sent_to,
          sent_at,
          is_critical
        ) VALUES (
          @repo_id,
          @score,
          @sent_to,
          @sent_at,
          @is_critical
        )
      `),
      listRecentAlerts: this.db.prepare(`
        SELECT
          id,
          repo_id,
          score,
          sent_to,
          sent_at,
          is_critical
        FROM alerts_sent
        ORDER BY sent_at DESC, id DESC
        LIMIT @limit
      `),
      getSourceHealth: this.db.prepare(`
        SELECT
          source,
          success_count,
          failure_count,
          consecutive_rate_limit_failures,
          last_status,
          last_error,
          last_success_at,
          last_failure_at,
          is_disabled,
          updated_at
        FROM source_health
        WHERE source = ?
      `),
      upsertSourceHealth: this.db.prepare(`
        INSERT INTO source_health (
          source,
          success_count,
          failure_count,
          consecutive_rate_limit_failures,
          last_status,
          last_error,
          last_success_at,
          last_failure_at,
          is_disabled,
          updated_at
        ) VALUES (
          @source,
          @success_count,
          @failure_count,
          @consecutive_rate_limit_failures,
          @last_status,
          @last_error,
          @last_success_at,
          @last_failure_at,
          @is_disabled,
          @updated_at
        )
        ON CONFLICT(source) DO UPDATE SET
          success_count = excluded.success_count,
          failure_count = excluded.failure_count,
          consecutive_rate_limit_failures = excluded.consecutive_rate_limit_failures,
          last_status = excluded.last_status,
          last_error = excluded.last_error,
          last_success_at = excluded.last_success_at,
          last_failure_at = excluded.last_failure_at,
          is_disabled = excluded.is_disabled,
          updated_at = excluded.updated_at
      `),
      listSourceHealth: this.db.prepare(`
        SELECT
          source,
          success_count,
          failure_count,
          consecutive_rate_limit_failures,
          last_status,
          last_error,
          last_success_at,
          last_failure_at,
          is_disabled,
          updated_at
        FROM source_health
        ORDER BY source ASC
      `),
      listDisabledSources: this.db.prepare(`
        SELECT
          source
        FROM source_health
        WHERE is_disabled = 1
        ORDER BY source ASC
      `),
      reenableSource: this.db.prepare(`
        UPDATE source_health
        SET
          is_disabled = 0,
          consecutive_rate_limit_failures = 0,
          updated_at = @updated_at
        WHERE source = @source
          AND is_disabled = 1
      `)
    };
  }

  insertSourceEvents(events) {
    if (!Array.isArray(events) || events.length === 0) {
      return 0;
    }

    const tx = this.db.transaction((rows) => {
      let inserted = 0;
      for (const event of rows) {
        const result = this.statements.insertSourceEvent.run({
          id: event.id,
          source: event.source,
          repo_id: event.repo_id,
          author_id: event.author_id || null,
          event_ts: event.event_ts,
          raw_url: event.raw_url,
          tier: event.tier || 'A'
        });
        inserted += result.changes;
      }
      return inserted;
    });

    return tx(events);
  }

  upsertRepository(repository) {
    const previous = this.statements.getRepository.get(repository.repo_id) || null;
    const previousStars = Number(previous?.stars) || 0;
    const currentStars = Number(repository.stars) || 0;

    this.statements.upsertRepository.run({
      repo_id: repository.repo_id,
      repo_url: repository.repo_url,
      created_at: repository.created_at || null,
      stars: currentStars,
      last_seen_at: repository.last_seen_at || null
    });

    if (!previous) {
      return { previousStars: 0, starDelta: 0 };
    }

    return {
      previousStars,
      starDelta: Math.max(0, currentStars - previousStars)
    };
  }

  getRepository(repoId) {
    return this.statements.getRepository.get(repoId) || null;
  }

  getEventsForRepoInWindow(repoId, windowStartIso, windowEndIso) {
    return this.statements.getEventsForRepoInWindow.all(repoId, windowStartIso, windowEndIso);
  }

  insertScoreSnapshot(snapshot) {
    this.statements.upsertScoreSnapshot.run(snapshot);
  }

  listTopRepos({ windowStartIso, limit = 20 }) {
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Number(limit))) : 20;
    return this.statements.listTopReposByLatestSnapshotInWindow.all({
      window_start: windowStartIso,
      limit: safeLimit
    });
  }

  getLatestAlert(repoId, sentTo) {
    return this.statements.getLatestAlert.get(repoId, sentTo) || null;
  }

  shouldSendAlert({
    repoId,
    sentTo,
    score,
    uniqueSourceCount,
    threshold,
    cooldownHours,
    minScoreDelta = 0,
    criticalMultiplier = 2,
    minUniqueSourceCount = 1,
    nowIso
  }) {
    if (Number(uniqueSourceCount) < Number(minUniqueSourceCount)) {
      return {
        shouldSend: false,
        critical: false,
        reason: 'insufficient_unique_sources',
        lastAlert: null
      };
    }

    if (score < threshold) {
      return {
        shouldSend: false,
        critical: false,
        reason: 'below_threshold',
        lastAlert: null
      };
    }

    const lastAlert = this.getLatestAlert(repoId, sentTo);
    if (!lastAlert) {
      return {
        shouldSend: true,
        critical: false,
        reason: 'first_alert',
        lastAlert: null
      };
    }

    const now = toEpoch(nowIso);
    const lastSent = toEpoch(lastAlert.sent_at);
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const lastAlertScore = Number(lastAlert.score) || 0;

    if (now - lastSent >= cooldownMs) {
      if (score - lastAlertScore < minScoreDelta) {
        return {
          shouldSend: false,
          critical: false,
          reason: 'score_delta_too_small',
          lastAlert
        };
      }

      return {
        shouldSend: true,
        critical: false,
        reason: 'cooldown_elapsed',
        lastAlert
      };
    }

    if (score >= lastAlertScore * criticalMultiplier) {
      return {
        shouldSend: true,
        critical: true,
        reason: 'critical_override',
        lastAlert
      };
    }

    return {
      shouldSend: false,
      critical: false,
      reason: 'cooldown_active',
      lastAlert
    };
  }

  insertAlert({ repoId, score, sentTo, sentAtIso, isCritical = false }) {
    const result = this.statements.insertAlert.run({
      repo_id: repoId,
      score,
      sent_to: sentTo,
      sent_at: sentAtIso,
      is_critical: isCritical ? 1 : 0
    });

    const alert = {
      id: Number(result.lastInsertRowid),
      repo_id: repoId,
      score,
      sent_to: sentTo,
      sent_at: sentAtIso,
      is_critical: isCritical ? 1 : 0
    };
    return alert;
  }

  listRecentAlerts({ limit = 50 }) {
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 50;
    return this.statements.listRecentAlerts.all({ limit: safeLimit });
  }

  getSourceHealth(source) {
    const row = this.statements.getSourceHealth.get(source);
    if (row) {
      return {
        ...row,
        is_disabled: Number(row.is_disabled) || 0
      };
    }

    return {
      source,
      success_count: 0,
      failure_count: 0,
      consecutive_rate_limit_failures: 0,
      last_status: null,
      last_error: null,
      last_success_at: null,
      last_failure_at: null,
      is_disabled: 0,
      updated_at: null
    };
  }

  recordSourceSuccess({ source, nowIso }) {
    const current = this.getSourceHealth(source);
    const next = {
      source,
      success_count: Number(current.success_count) + 1,
      failure_count: Number(current.failure_count) || 0,
      consecutive_rate_limit_failures: 0,
      last_status: null,
      last_error: null,
      last_success_at: nowIso,
      last_failure_at: current.last_failure_at || null,
      is_disabled: 0,
      updated_at: nowIso
    };
    this.statements.upsertSourceHealth.run(next);
    return next;
  }

  recordSourceFailure({
    source,
    status = null,
    errorMessage = null,
    nowIso,
    rateLimitFailureThreshold = DEFAULT_RATE_LIMIT_FAILURE_THRESHOLD
  }) {
    const current = this.getSourceHealth(source);
    const rateLimitFailureCount = RATE_LIMIT_STATUSES.has(Number(status))
      ? Number(current.consecutive_rate_limit_failures) + 1
      : 0;
    const disabled = rateLimitFailureCount >= rateLimitFailureThreshold;

    const next = {
      source,
      success_count: Number(current.success_count) || 0,
      failure_count: Number(current.failure_count) + 1,
      consecutive_rate_limit_failures: rateLimitFailureCount,
      last_status: Number.isFinite(Number(status)) ? Number(status) : null,
      last_error: errorMessage || null,
      last_success_at: current.last_success_at || null,
      last_failure_at: nowIso,
      is_disabled: disabled ? 1 : Number(current.is_disabled) || 0,
      updated_at: nowIso
    };
    this.statements.upsertSourceHealth.run(next);
    return next;
  }

  isSourceDisabled(source) {
    const state = this.getSourceHealth(source);
    return Number(state.is_disabled) === 1;
  }

  listSourceHealth() {
    return this.statements.listSourceHealth.all();
  }

  reenableDisabledSources({ nowIso }) {
    const rows = this.statements.listDisabledSources.all();
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }

    const tx = this.db.transaction((items) => {
      const changed = [];
      for (const item of items) {
        const source = item.source;
        if (!source) {
          continue;
        }
        const result = this.statements.reenableSource.run({
          source,
          updated_at: nowIso
        });
        if (result.changes > 0) {
          changed.push(source);
        }
      }
      return changed;
    });

    return tx(rows);
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}
