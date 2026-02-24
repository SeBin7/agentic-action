import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeRepository } from '../src/db/repository.js';
import { runPipeline } from '../src/index.js';

function makeRepo(prefix = 'trend-oss-health-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const dbPath = path.join(dir, 'runtime_db.json');
  const repo = new RuntimeRepository({ dbPath, logger: null });
  return { dir, dbPath, repo };
}

test('source is disabled after 3 consecutive rate-limit failures', () => {
  const { repo } = makeRepo();

  let state = repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T00:00:00.000Z',
    rateLimitFailureThreshold: 3
  });
  assert.equal(state.consecutive_rate_limit_failures, 1);
  assert.equal(state.is_disabled, 0);

  state = repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T00:01:00.000Z',
    rateLimitFailureThreshold: 3
  });
  assert.equal(state.consecutive_rate_limit_failures, 2);
  assert.equal(state.is_disabled, 0);

  state = repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T00:02:00.000Z',
    rateLimitFailureThreshold: 3
  });
  assert.equal(state.consecutive_rate_limit_failures, 3);
  assert.equal(state.is_disabled, 1);
  assert.equal(repo.isSourceDisabled('hn'), true);
});

test('non-rate-limit failure resets consecutive rate-limit counter', () => {
  const { repo } = makeRepo();

  repo.recordSourceFailure({
    source: 'reddit',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T01:00:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.recordSourceFailure({
    source: 'reddit',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T01:01:00.000Z',
    rateLimitFailureThreshold: 3
  });

  const state = repo.recordSourceFailure({
    source: 'reddit',
    status: 500,
    errorMessage: 'HTTP 500',
    nowIso: '2026-02-24T01:02:00.000Z',
    rateLimitFailureThreshold: 3
  });

  assert.equal(state.consecutive_rate_limit_failures, 0);
  assert.equal(state.is_disabled, 0);
});

test('success clears disabled state and consecutive failures', () => {
  const { repo } = makeRepo();

  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T02:00:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T02:01:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T02:02:00.000Z',
    rateLimitFailureThreshold: 3
  });
  assert.equal(repo.isSourceDisabled('hn'), true);

  const state = repo.recordSourceSuccess({
    source: 'hn',
    nowIso: '2026-02-24T02:03:00.000Z'
  });
  assert.equal(state.consecutive_rate_limit_failures, 0);
  assert.equal(state.is_disabled, 0);
  assert.equal(repo.isSourceDisabled('hn'), false);
});

test('pipeline skips disabled source when re-enable-on-start is false', async () => {
  const { dir, dbPath, repo } = makeRepo('trend-oss-health-skip-');

  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T03:00:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T03:01:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T03:02:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.close();

  let fetchCalled = false;
  const summary = await runPipeline({
    dryRun: false,
    envOverrides: {
      DB_PATH: dbPath,
      LOG_PATH: path.join(dir, 'operations.log'),
      ENABLE_HN: 'true',
      ENABLE_REDDIT: 'false',
      SOURCE_REENABLE_ON_START: 'false'
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called when source is disabled');
    },
    now: () => new Date('2026-02-24T03:10:00.000Z')
  });

  assert.equal(fetchCalled, false);
  assert.equal(summary.rawEventCount, 0);
  assert.equal(summary.extractedEventCount, 0);
});

test('pipeline re-enables disabled source on start when configured', async () => {
  const { dir, dbPath, repo } = makeRepo('trend-oss-health-reenable-');

  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T04:00:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T04:01:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.recordSourceFailure({
    source: 'hn',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T04:02:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.close();

  const summary = await runPipeline({
    dryRun: true,
    envOverrides: {
      DB_PATH: dbPath,
      LOG_PATH: path.join(dir, 'operations.log'),
      ENABLE_HN: 'true',
      ENABLE_REDDIT: 'false',
      SOURCE_REENABLE_ON_START: 'true'
    },
    now: () => new Date('2026-02-24T04:10:00.000Z')
  });

  assert.equal(summary.rawEventCount, 2);

  const afterRepo = new RuntimeRepository({ dbPath, logger: null });
  assert.equal(afterRepo.isSourceDisabled('hn'), false);
  afterRepo.close();
});
