import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RuntimeRepository } from '../src/db/repository.js';
import { createAppServer } from '../src/server/index.js';

async function startApp(envOverrides) {
  const app = createAppServer({ envOverrides, now: () => new Date('2026-02-24T00:00:00.000Z') });
  await new Promise((resolve, reject) => {
    app.server.listen(0, '127.0.0.1', (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    app.server.on('error', reject);
  });

  const address = app.server.address();
  const port = Number(address.port);
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`
  };
}

function makeDbFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trend-oss-api-'));
  const dbPath = path.join(dir, 'runtime_db.json');
  const logPath = path.join(dir, 'operations.log');
  const repo = new RuntimeRepository({ dbPath, logger: null });

  repo.insertScoreSnapshot({
    repo_id: 'openai/openai-node',
    window_start: '2026-02-23T00:00:00.000Z',
    window_end: '2026-02-24T00:00:00.000Z',
    mention_count: 5,
    unique_source_count: 2,
    star_delta: 12,
    score: 15.5
  });
  repo.insertScoreSnapshot({
    repo_id: 'vercel/next.js',
    window_start: '2026-02-23T00:00:00.000Z',
    window_end: '2026-02-24T00:00:00.000Z',
    mention_count: 4,
    unique_source_count: 2,
    star_delta: 9,
    score: 14.1
  });
  repo.insertAlert({
    repoId: 'openai/openai-node',
    score: 15.5,
    sentTo: 'discord',
    sentAtIso: '2026-02-24T00:00:00.000Z',
    isCritical: true
  });
  repo.recordSourceSuccess({
    source: 'hn',
    nowIso: '2026-02-24T00:00:00.000Z'
  });
  repo.recordSourceFailure({
    source: 'reddit',
    status: 429,
    errorMessage: 'HTTP 429',
    nowIso: '2026-02-24T00:01:00.000Z',
    rateLimitFailureThreshold: 3
  });
  repo.close();

  return { dbPath, logPath };
}

test('api endpoints return expected payload shape', async () => {
  const fixture = makeDbFixture();
  const { app, baseUrl } = await startApp({
    RUNTIME_DB_PATH: fixture.dbPath,
    DB_PATH: fixture.dbPath,
    LOG_PATH: fixture.logPath,
    API_HOST: '127.0.0.1',
    API_PORT: '0'
  });

  try {
    const health = await fetch(`${baseUrl}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(typeof health.dbPath, 'string');

    const repos = await fetch(`${baseUrl}/api/repos/top?limit=5&windowHours=24`).then((res) => res.json());
    assert.equal(repos.ok, true);
    assert.equal(repos.items.length, 2);
    assert.equal(repos.items[0].repoId, 'openai/openai-node');

    const alerts = await fetch(`${baseUrl}/api/alerts?limit=10`).then((res) => res.json());
    assert.equal(alerts.ok, true);
    assert.equal(alerts.items.length, 1);
    assert.equal(alerts.items[0].isCritical, true);

    const sourceHealth = await fetch(`${baseUrl}/api/sources/health`).then((res) => res.json());
    assert.equal(sourceHealth.ok, true);
    assert.equal(sourceHealth.items.length >= 2, true);
  } finally {
    await app.close();
  }
});

test('missing runtime DB returns structured 500', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trend-oss-api-missing-'));
  const missingDb = path.join(dir, 'not-found-runtime_db.json');
  const logPath = path.join(dir, 'operations.log');

  const { app, baseUrl } = await startApp({
    RUNTIME_DB_PATH: missingDb,
    DB_PATH: missingDb,
    LOG_PATH: logPath,
    API_HOST: '127.0.0.1',
    API_PORT: '0'
  });

  try {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'api_boot_failed');
  } finally {
    await app.close();
  }
});
