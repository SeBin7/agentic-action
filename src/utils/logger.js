import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function createLogger({ logPath, now = () => new Date() }) {
  mkdirSync(path.dirname(logPath), { recursive: true });

  function write(level, event, details = {}) {
    const entry = {
      ts: now().toISOString(),
      level,
      event,
      ...details
    };
    const line = `${JSON.stringify(entry)}\n`;
    appendFileSync(logPath, line, 'utf8');

    if (level === 'error') {
      console.error(line.trimEnd());
      return;
    }
    console.log(line.trimEnd());
  }

  return {
    info: (event, details) => write('info', event, details),
    error: (event, details) => write('error', event, details)
  };
}
