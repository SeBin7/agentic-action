import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateScoreV1 } from '../src/pipeline/score.js';

test('score formula v1 matches expected baseline case', () => {
  const result = calculateScoreV1({
    mentionCount: 2,
    uniqueSourceCount: 2,
    starDelta: 100
  });

  assert.equal(result.score, 16.0);
  assert.equal(result.components.weightedMentionCount, 2);
  assert.equal(result.components.mentionScore, 2);
  assert.equal(result.components.uniqueSourceScore, 10);
  assert.equal(result.components.tierCPenaltyApplied, false);
});

test('tier c mentions apply 0.5 penalty', () => {
  const result = calculateScoreV1({
    mentionCount: 4,
    uniqueSourceCount: 1,
    starDelta: 0,
    tierCMentionCount: 2
  });

  assert.equal(result.score, 8.0);
  assert.equal(result.components.weightedMentionCount, 3);
  assert.equal(result.components.mentionScore, 3);
  assert.equal(result.components.uniqueSourceScore, 5);
  assert.equal(result.components.starDeltaScore, 0);
  assert.equal(result.components.tierCPenaltyApplied, true);
});
