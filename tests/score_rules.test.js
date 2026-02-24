import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { calculateScoreV1 } from '../src/pipeline/score.js';
import { DEFAULT_SCORE_RULES, loadScoreRules } from '../src/config/score_rules.js';

test('loadScoreRules loads file rule set', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trend-oss-score-rules-'));
  const ruleFile = path.join(dir, 'rules.json');
  writeFileSync(
    ruleFile,
    JSON.stringify({
      mention: 2,
      uniqueSource: 1,
      starDelta: 1.5,
      tierCPenalty: 0.4
    }),
    'utf8'
  );

  const loaded = loadScoreRules({
    env: {
      SCORE_RULES_PATH: ruleFile
    }
  });

  assert.equal(loaded.source, 'file');
  assert.equal(loaded.rules.mention, 2);
  assert.equal(loaded.rules.uniqueSource, 1);
  assert.equal(loaded.rules.starDelta, 1.5);
  assert.equal(loaded.rules.tierCPenalty, 0.4);
});

test('loadScoreRules falls back to defaults when file is missing', () => {
  const loaded = loadScoreRules({
    env: {
      SCORE_RULES_PATH: '/tmp/not-found-score-rules.json'
    }
  });

  assert.equal(loaded.source, 'default');
  assert.equal(loaded.rules.mention, DEFAULT_SCORE_RULES.mention);
  assert.equal(loaded.rules.uniqueSource, DEFAULT_SCORE_RULES.uniqueSource);
  assert.equal(loaded.rules.starDelta, DEFAULT_SCORE_RULES.starDelta);
  assert.equal(loaded.rules.tierCPenalty, DEFAULT_SCORE_RULES.tierCPenalty);
});

test('calculateScoreV1 applies injected score rules', () => {
  const result = calculateScoreV1(
    {
      mentionCount: 2,
      uniqueSourceCount: 2,
      starDelta: 100,
      tierCMentionCount: 0
    },
    {
      mention: 2,
      uniqueSource: 1,
      starDelta: 1,
      tierCPenalty: 0.5
    }
  );

  assert.equal(result.score, 8);
});
