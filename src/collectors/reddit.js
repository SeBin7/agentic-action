import { fetchWithRetry } from '../utils/http.js';

function buildDryRunEvents(nowIso) {
  return [
    {
      source: 'reddit',
      source_id: 'dry-reddit-1',
      author_id: 'dry-redditor-1',
      event_ts: nowIso,
      raw_url: 'https://www.reddit.com/r/programming/comments/dry1',
      text: 'Stable tooling release: https://github.com/openai/openai-node'
    },
    {
      source: 'reddit',
      source_id: 'dry-reddit-2',
      author_id: 'dry-redditor-2',
      event_ts: nowIso,
      raw_url: 'https://www.reddit.com/r/programming/comments/dry2',
      text: 'Runtime discussion for https://github.com/denoland/deno'
    },
    {
      source: 'reddit',
      source_id: 'dry-reddit-3',
      author_id: 'dry-redditor-3',
      event_ts: nowIso,
      raw_url: 'https://www.reddit.com/r/programming/comments/dry3',
      text: 'Next.js upgrade notes https://github.com/vercel/next.js/issues/1'
    }
  ];
}

export async function collectReddit({
  subreddit,
  limit,
  dryRun,
  nowIso,
  httpOptions,
  logger,
  fetchImpl = fetch
}) {
  if (dryRun) {
    const events = buildDryRunEvents(nowIso);
    logger?.info('collector.reddit.success', { mode: 'dry-run', count: events.length });
    return events;
  }

  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=${limit}`;
  const response = await fetchWithRetry(url, {
    ...httpOptions,
    headers: {
      'User-Agent': 'trend-oss-tracker/0.1'
    },
    fetchImpl,
    logger,
    eventName: 'collector.reddit.feed'
  });

  const payload = await response.json();
  const children = payload?.data?.children || [];

  const events = children.map((entry) => {
    const data = entry?.data || {};
    const eventTs = data.created_utc ? new Date(data.created_utc * 1000).toISOString() : nowIso;
    const text = [data.title, data.selftext, data.url].filter(Boolean).join(' ');
    return {
      source: 'reddit',
      source_id: data.id || '',
      author_id: data.author || null,
      event_ts: eventTs,
      raw_url: data.url || `https://www.reddit.com${data.permalink || ''}`,
      text
    };
  });

  logger?.info('collector.reddit.success', { mode: 'live', count: events.length });
  return events;
}
