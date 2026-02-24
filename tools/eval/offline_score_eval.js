import { readFileSync } from 'node:fs';
import path from 'node:path';
import { calculateScoreV1 } from '../../src/pipeline/score.js';
import { loadScoreRules } from '../../src/config/score_rules.js';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function overlapRatio(actualTop10, baselineTop10) {
  const baselineSet = new Set(baselineTop10);
  if (baselineSet.size === 0) {
    return 0;
  }
  const matched = actualTop10.filter((repoId) => baselineSet.has(repoId)).length;
  return matched / baselineSet.size;
}

function rankRepos(dataset, rules) {
  return dataset
    .map((row) => {
      const scoreResult = calculateScoreV1({
        mentionCount: row.mentionCount,
        uniqueSourceCount: row.uniqueSourceCount,
        starDelta: row.starDelta,
        tierCMentionCount: row.tierCMentionCount || 0
      }, rules);
      return { repoId: row.repoId, score: scoreResult.score };
    })
    .sort((a, b) => b.score - a.score || a.repoId.localeCompare(b.repoId));
}

function main() {
  const datasetPath = path.resolve(process.env.SCORE_EVAL_DATASET_PATH || 'tests/fixtures/offline_eval_dataset.json');
  const baselinePath = path.resolve(
    process.env.SCORE_EVAL_BASELINE_PATH || 'tests/fixtures/offline_eval_baseline.top10.json'
  );
  const threshold = Number(process.env.SCORE_EVAL_MIN_OVERLAP || 0.95);

  const dataset = readJson(datasetPath);
  const baseline = readJson(baselinePath);
  const baselineTop10 = Array.isArray(baseline.top10) ? baseline.top10 : [];
  const scoreRules = loadScoreRules().rules;
  const ranked = rankRepos(dataset, scoreRules);
  const top10 = ranked.slice(0, 10).map((row) => row.repoId);
  const ratio = overlapRatio(top10, baselineTop10);
  const passed = ratio >= threshold;

  const summary = {
    datasetPath,
    baselinePath,
    top10,
    overlapRatio: Number(ratio.toFixed(3)),
    threshold,
    passed
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!passed) {
    process.exit(1);
  }
}

main();
