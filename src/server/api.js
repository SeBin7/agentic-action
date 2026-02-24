import { existsSync } from 'node:fs';
import path from 'node:path';
import { RuntimeRepository } from '../db/repository.js';

function asPositiveInt(value, fallback, { min = 1, max = 1000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function errorPayload(code, message, details = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...details
    }
  };
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function buildTopReposPayload(rows) {
  return rows.map((row) => ({
    repoId: row.repo_id,
    score: Number(row.score),
    mentionCount: Number(row.mention_count),
    uniqueSourceCount: Number(row.unique_source_count),
    starDelta: Number(row.star_delta),
    windowEnd: row.window_end
  }));
}

function buildAlertsPayload(rows) {
  return rows.map((row) => ({
    id: Number(row.id),
    repoId: row.repo_id,
    score: Number(row.score),
    sentTo: row.sent_to,
    sentAt: row.sent_at,
    isCritical: Number(row.is_critical) === 1
  }));
}

function buildSourceHealthPayload(rows) {
  return rows.map((row) => ({
    source: row.source,
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    consecutiveRateLimitFailures: Number(row.consecutive_rate_limit_failures),
    isDisabled: Number(row.is_disabled) === 1,
    updatedAt: row.updated_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at
  }));
}

export function createApiService({
  env,
  logger,
  now = () => new Date()
}) {
  const dbPath = path.resolve(env.runtimeDbPath || env.dbPath || 'data/runtime_db.json');
  if (!existsSync(dbPath)) {
    throw new Error(`runtime_db_missing:${dbPath}`);
  }

  const repo = new RuntimeRepository({ dbPath, logger });

  function close() {
    repo.close();
  }

  function handle(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname || '/';
    const query = parsedUrl.searchParams;

    try {
      if (pathname === '/api/health') {
        return jsonResponse(res, 200, {
          ok: true,
          dbPath,
          nowIso: now().toISOString(),
          version: 'p2-api-v1'
        });
      }

      if (pathname === '/api/repos/top') {
        const limit = asPositiveInt(query.get('limit'), 20, { min: 1, max: 200 });
        const windowHours = asPositiveInt(query.get('windowHours'), 24, { min: 1, max: 720 });
        const windowStartIso = new Date(now().getTime() - windowHours * 60 * 60 * 1000).toISOString();
        const rows = repo.listTopRepos({ windowStartIso, limit });
        return jsonResponse(res, 200, {
          ok: true,
          limit,
          windowHours,
          items: buildTopReposPayload(rows)
        });
      }

      if (pathname === '/api/alerts') {
        const limit = asPositiveInt(query.get('limit'), 50, { min: 1, max: 500 });
        const rows = repo.listRecentAlerts({ limit });
        return jsonResponse(res, 200, {
          ok: true,
          limit,
          items: buildAlertsPayload(rows)
        });
      }

      if (pathname === '/api/sources/health') {
        const rows = repo.listSourceHealth();
        return jsonResponse(res, 200, {
          ok: true,
          items: buildSourceHealthPayload(rows)
        });
      }
    } catch (error) {
      logger?.error('api.request.failure', {
        path: pathname,
        reason: error.message
      });
      return jsonResponse(
        res,
        500,
        errorPayload('api_internal_error', 'API request failed', {
          path: pathname,
          reason: error.message
        })
      );
    }

    return false;
  }

  return {
    dbPath,
    close,
    handle
  };
}

export function sendApiNotFound(res, pathname) {
  return jsonResponse(
    res,
    404,
    errorPayload('not_found', 'Not found', {
      path: pathname
    })
  );
}

export function sendApiBootError(res, error) {
  return jsonResponse(
    res,
    500,
    errorPayload('api_boot_failed', 'API boot failed', {
      reason: error.message
    })
  );
}
