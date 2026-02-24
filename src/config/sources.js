const VALID_TIERS = new Set(['A', 'B', 'C']);

function resolveTier(tier) {
  return VALID_TIERS.has(tier) ? tier : 'A';
}

export function getSourceConfig(env) {
  return {
    hn: {
      enabled: env.enableHn,
      tier: resolveTier(env.hnTier)
    },
    reddit: {
      enabled: env.enableReddit,
      tier: resolveTier(env.redditTier)
    }
  };
}
