const WEIGHTS = {
  mention: 1.0,
  uniqueSource: 5.0,
  starDelta: 2.0,
  tierCPenalty: 0.5
};

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function calculateScoreV1({
  mentionCount,
  uniqueSourceCount,
  starDelta,
  tierCMentionCount = 0
}) {
  const safeMention = Math.max(0, mentionCount);
  const safeUniqueSource = Math.max(0, uniqueSourceCount);
  const safeDelta = Math.max(0, starDelta);
  const safeTierC = Math.max(0, tierCMentionCount);

  const weightedMentionCount = safeMention - safeTierC + safeTierC * WEIGHTS.tierCPenalty;
  const mentionScore = WEIGHTS.mention * weightedMentionCount;
  const uniqueSourceScore = WEIGHTS.uniqueSource * safeUniqueSource;
  const starDeltaScore = WEIGHTS.starDelta * Math.log10(safeDelta + 1);

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
