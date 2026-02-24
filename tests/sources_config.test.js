import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/config/env.js';
import { getSourceConfig } from '../src/config/sources.js';

test('loadEnv exposes default source tiers', () => {
  const env = loadEnv({ env: {} });

  assert.equal(env.hnTier, 'A');
  assert.equal(env.redditTier, 'A');
});

test('getSourceConfig uses valid source tier values', () => {
  const env = loadEnv({
    env: {
      HN_TIER: 'B',
      REDDIT_TIER: 'C'
    }
  });
  const sourceConfig = getSourceConfig(env);

  assert.equal(sourceConfig.hn.tier, 'B');
  assert.equal(sourceConfig.reddit.tier, 'C');
});

test('getSourceConfig falls back to A for invalid tier values', () => {
  const env = loadEnv({
    env: {
      HN_TIER: 'X',
      REDDIT_TIER: 'invalid'
    }
  });
  const sourceConfig = getSourceConfig(env);

  assert.equal(sourceConfig.hn.tier, 'A');
  assert.equal(sourceConfig.reddit.tier, 'A');
});
