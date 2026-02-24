import { fetchWithRetry } from '../utils/http.js';

export async function sendDiscordWebhook({
  webhookUrl,
  payload,
  dryRun,
  httpOptions,
  logger,
  fetchImpl = fetch
}) {
  if (dryRun) {
    logger?.info('notifier.discord.skipped', { reason: 'dry_run' });
    return { sent: true, reason: 'dry_run' };
  }

  if (!webhookUrl) {
    logger?.info('notifier.discord.skipped', { reason: 'webhook_missing' });
    return { sent: false, reason: 'webhook_missing' };
  }

  await fetchWithRetry(webhookUrl, {
    ...httpOptions,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    fetchImpl,
    logger,
    eventName: 'notifier.discord.post'
  });

  logger?.info('notifier.discord.success', { reason: 'sent' });
  return { sent: true, reason: 'sent' };
}
