import { fetchWithRetry } from '../utils/http.js';

function buildDryRunEvents(nowIso) {
  return [
    {
      source: 'hn',
      source_id: 'dry-hn-1',
      author_id: 'dry-user-1',
      event_ts: nowIso,
      raw_url: 'https://news.ycombinator.com/item?id=dry-hn-1',
      text: 'A practical SDK write-up: https://github.com/openai/openai-node'
    },
    {
      source: 'hn',
      source_id: 'dry-hn-2',
      author_id: 'dry-user-2',
      event_ts: nowIso,
      raw_url: 'https://news.ycombinator.com/item?id=dry-hn-2',
      text: 'Frontend benchmark thread around https://github.com/vercel/next.js'
    }
  ];
}

export async function collectHackerNews({
  limit,
  dryRun,
  nowIso,
  httpOptions,
  logger,
  fetchImpl = fetch
}) {
  if (dryRun) {
    const events = buildDryRunEvents(nowIso);
    logger?.info('collector.hn.success', { mode: 'dry-run', count: events.length });
    return events;
  }

  const topStoriesUrl = 'https://hacker-news.firebaseio.com/v0/topstories.json';
  const response = await fetchWithRetry(topStoriesUrl, {
    ...httpOptions,
    fetchImpl,
    logger,
    eventName: 'collector.hn.topstories'
  });

  const ids = (await response.json()).slice(0, limit);
  const events = [];

  for (const id of ids) {
    const itemUrl = `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
    try {
      const itemResponse = await fetchWithRetry(itemUrl, {
        ...httpOptions,
        fetchImpl,
        logger,
        eventName: 'collector.hn.item'
      });
      const item = await itemResponse.json();
      if (!item) {
        continue;
      }

      const eventTs = item.time ? new Date(item.time * 1000).toISOString() : nowIso;
      const itemText = [item.title, item.text, item.url].filter(Boolean).join(' ');
      events.push({
        source: 'hn',
        source_id: String(item.id),
        author_id: item.by || null,
        event_ts: eventTs,
        raw_url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        text: itemText
      });
    } catch (error) {
      logger?.error('collector.hn.item.failure', {
        itemId: id,
        reason: error.message
      });
    }
  }

  logger?.info('collector.hn.success', { mode: 'live', count: events.length });
  return events;
}
