import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RuntimeRepository } from '../src/db/repository.js';
import { runPipeline } from '../src/index.js';

function countRows(dbPath, tableName) {
  const allowed = new Set(['alerts_sent', 'repo_score_snapshots']);
  if (!allowed.has(tableName)) {
    throw new Error(`unsupported tableName: ${tableName}`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
    return Number(row?.count || 0);
  } finally {
    db.close();
  }
}

test('cooldown blocks alert unless score doubles', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trend-oss-db-'));
  const dbPath = path.join(dir, 'runtime_db.json');
  const logPath = path.join(dir, 'operations.log');
  const repo = new RuntimeRepository({ dbPath, logger: null });

  repo.insertAlert({
    repoId: 'openai/openai-node',
    score: 12,
    sentTo: 'discord',
    sentAtIso: '2026-02-23T00:00:00.000Z'
  });

  const regularDecision = repo.shouldSendAlert({
    repoId: 'openai/openai-node',
    sentTo: 'discord',
    score: 13,
    uniqueSourceCount: 2,
    threshold: 12,
    cooldownHours: 24,
    minScoreDelta: 0.5,
    criticalMultiplier: 2,
    minUniqueSourceCount: 1,
    nowIso: '2026-02-23T12:00:00.000Z'
  });
  assert.equal(regularDecision.shouldSend, false);
  assert.equal(regularDecision.reason, 'cooldown_active');

  const criticalDecision = repo.shouldSendAlert({
    repoId: 'openai/openai-node',
    sentTo: 'discord',
    score: 24,
    uniqueSourceCount: 2,
    threshold: 12,
    cooldownHours: 24,
    minScoreDelta: 0.5,
    criticalMultiplier: 2,
    minUniqueSourceCount: 1,
    nowIso: '2026-02-23T12:00:00.000Z'
  });
  assert.equal(criticalDecision.shouldSend, true);
  assert.equal(criticalDecision.reason, 'critical_override');

  const smallDeltaDecision = repo.shouldSendAlert({
    repoId: 'openai/openai-node',
    sentTo: 'discord',
    score: 12.3,
    uniqueSourceCount: 2,
    threshold: 12,
    cooldownHours: 24,
    minScoreDelta: 0.5,
    criticalMultiplier: 2,
    minUniqueSourceCount: 1,
    nowIso: '2026-02-24T01:00:00.000Z'
  });
  assert.equal(smallDeltaDecision.shouldSend, false);
  assert.equal(smallDeltaDecision.reason, 'score_delta_too_small');

  const elapsedDecision = repo.shouldSendAlert({
    repoId: 'openai/openai-node',
    sentTo: 'discord',
    score: 13,
    uniqueSourceCount: 2,
    threshold: 12,
    cooldownHours: 24,
    minScoreDelta: 0.5,
    criticalMultiplier: 2,
    minUniqueSourceCount: 1,
    nowIso: '2026-02-24T01:00:00.000Z'
  });
  assert.equal(elapsedDecision.shouldSend, true);
  assert.equal(elapsedDecision.reason, 'cooldown_elapsed');

  const alertCount = countRows(dbPath, 'alerts_sent');
  assert.equal(alertCount, 1);
  repo.close();

  void logPath;
});

test('dry-run pipeline produces snapshots and alerts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trend-oss-pipeline-'));
  const dbPath = path.join(dir, 'runtime_db.json');
  const logPath = path.join(dir, 'operations.log');

  const summary = await runPipeline({
    dryRun: true,
    envOverrides: {
      DB_PATH: dbPath,
      LOG_PATH: logPath,
      ENABLE_HN: 'true',
      ENABLE_REDDIT: 'true'
    },
    now: () => new Date('2026-02-23T10:00:00.000Z')
  });

  assert.equal(summary.rawEventCount, 5);
  assert.equal(summary.repoCount >= 3, true);

  const snapshotCount = countRows(dbPath, 'repo_score_snapshots');
  const alertCount = countRows(dbPath, 'alerts_sent');
  assert.equal(snapshotCount >= 3, true);
  assert.equal(alertCount >= 1, true);
});

test('minimum unique source rule blocks alert', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trend-oss-db-'));
  const dbPath = path.join(dir, 'runtime_db.json');
  const repo = new RuntimeRepository({ dbPath, logger: null });

  const decision = repo.shouldSendAlert({
    repoId: 'openai/openai-node',
    sentTo: 'discord',
    score: 20,
    uniqueSourceCount: 1,
    threshold: 12,
    cooldownHours: 24,
    minScoreDelta: 0.5,
    criticalMultiplier: 2,
    minUniqueSourceCount: 2,
    nowIso: '2026-02-24T01:00:00.000Z'
  });

  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, 'insufficient_unique_sources');
  repo.close();
});
