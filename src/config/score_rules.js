import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SCORE_RULES = {
  mention: 1.0,
  uniqueSource: 5.0,
  starDelta: 2.0,
  tierCPenalty: 0.5
};

const DEFAULT_RULES_PATH = 'config/score_rules.v1.json';

function asPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export function normalizeScoreRules(rawRules = {}) {
  return {
    mention: asPositiveNumber(rawRules.mention, DEFAULT_SCORE_RULES.mention),
    uniqueSource: asPositiveNumber(rawRules.uniqueSource, DEFAULT_SCORE_RULES.uniqueSource),
    starDelta: asPositiveNumber(rawRules.starDelta, DEFAULT_SCORE_RULES.starDelta),
    tierCPenalty: asPositiveNumber(rawRules.tierCPenalty, DEFAULT_SCORE_RULES.tierCPenalty)
  };
}

export function resolveScoreRulesPath({ env = process.env } = {}) {
  const fromEnv = String(env.SCORE_RULES_PATH || '').trim();
  if (!fromEnv) {
    return path.resolve(DEFAULT_RULES_PATH);
  }
  return path.resolve(fromEnv);
}

export function loadScoreRules({ env = process.env } = {}) {
  const rulesPath = resolveScoreRulesPath({ env });

  try {
    const raw = JSON.parse(readFileSync(rulesPath, 'utf8'));
    return {
      rules: normalizeScoreRules(raw),
      source: 'file',
      path: rulesPath,
      error: null
    };
  } catch (error) {
    return {
      rules: { ...DEFAULT_SCORE_RULES },
      source: 'default',
      path: rulesPath,
      error: error.message
    };
  }
}
