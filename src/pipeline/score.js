import { DEFAULT_SCORE_RULES, normalizeScoreRules } from '../config/score_rules.js';

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function calculateScoreV1({
  mentionCount,
  uniqueSourceCount,
  starDelta,
  tierCMentionCount = 0
}, rules = DEFAULT_SCORE_RULES) {
  const activeRules = normalizeScoreRules(rules);
  const safeMention = Math.max(0, mentionCount);
  const safeUniqueSource = Math.max(0, uniqueSourceCount);
  const safeDelta = Math.max(0, starDelta);
  const safeTierC = Math.max(0, tierCMentionCount);

  const weightedMentionCount = safeMention - safeTierC + safeTierC * activeRules.tierCPenalty;
  const mentionScore = activeRules.mention * weightedMentionCount;
  const uniqueSourceScore = activeRules.uniqueSource * safeUniqueSource;
  const starDeltaScore = activeRules.starDelta * Math.log10(safeDelta + 1);

  const rawScore = mentionScore + uniqueSourceScore + starDeltaScore;

  return {
    rawScore,
    score: round1(rawScore),
    components: {
      weightedMentionCount,
      mentionScore,
      uniqueSourceScore,
      starDeltaScore,
      tierCPenaltyApplied: safeTierC > 0
    }
  };
}
