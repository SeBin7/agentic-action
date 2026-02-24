import { fetchWithRetry } from '../utils/http.js';

function hashRepo(repoId) {
  let hash = 0;
  for (let i = 0; i < repoId.length; i += 1) {
    hash = (hash << 5) - hash + repoId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function buildDryRunMetadata(repoId, nowIso) {
  const stars = 100 + (hashRepo(repoId) % 3000);
  return {
    repo_id: repoId,
    repo_url: `https://github.com/${repoId}`,
    created_at: '2024-01-01T00:00:00.000Z',
    stars,
    last_seen_at: nowIso
  };
}

export async function enrichGitHubRepository({
  repoId,
  token,
  dryRun,
  nowIso,
  httpOptions,
  logger,
  fetchImpl = fetch
}) {
  if (dryRun) {
    const metadata = buildDryRunMetadata(repoId, nowIso);
    logger?.info('enricher.github.success', { repoId, mode: 'dry-run', stars: metadata.stars });
    return metadata;
  }

  const url = `https://api.github.com/repos/${repoId}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'trend-oss-tracker/0.1'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchWithRetry(url, {
    ...httpOptions,
    headers,
    fetchImpl,
    logger,
    eventName: 'enricher.github.repo'
  });

  const payload = await response.json();
  const metadata = {
    repo_id: repoId,
    repo_url: payload.html_url || `https://github.com/${repoId}`,
    created_at: payload.created_at || null,
    stars: Number(payload.stargazers_count) || 0,
    last_seen_at: nowIso
  };
  logger?.info('enricher.github.success', { repoId, mode: 'live', stars: metadata.stars });
  return metadata;
}
