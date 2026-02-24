const URL_CANDIDATE_REGEX = /https?:\/\/[^\s)\]}>"']+/gi;

function trimTrailingPunctuation(value) {
  return value.replace(/[.,!?;:]+$/g, '');
}

export function normalizeGitHubUrl(rawValue) {
  if (!rawValue) {
    return null;
  }

  const cleaned = trimTrailingPunctuation(rawValue.trim());
  let parsed;

  try {
    parsed = new URL(cleaned);
  } catch (_error) {
    return null;
  }

  if (!['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) {
    return null;
  }

  const segments = parsed.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0].toLowerCase();
  let repo = segments[1].toLowerCase();
  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }

  if (!owner || !repo) {
    return null;
  }

  const repoId = `${owner}/${repo}`;
  return {
    repoId,
    repoUrl: `https://github.com/${owner}/${repo}`
  };
}

export function extractRepositoryMatches(text) {
  if (!text) {
    return [];
  }

  const deduped = new Map();
  const matches = String(text).match(URL_CANDIDATE_REGEX) || [];

  for (const match of matches) {
    const normalized = normalizeGitHubUrl(match);
    if (!normalized) {
      continue;
    }
    deduped.set(normalized.repoId, normalized);
  }

  return [...deduped.values()];
}
