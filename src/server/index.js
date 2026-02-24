import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { createApiService, sendApiBootError, sendApiNotFound } from './api.js';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function resolveContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function serveStaticFile(res, filePath) {
  if (!existsSync(filePath)) {
    return false;
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return false;
  }

  res.writeHead(200, {
    'Content-Type': resolveContentType(filePath),
    'Content-Length': stat.size,
    'Cache-Control': 'no-store'
  });
  createReadStream(filePath).pipe(res);
  return true;
}

function staticPathFromRequest(distDir, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(safePath).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(distDir, normalized);
}

export function createAppServer({
  envOverrides = {},
  now = () => new Date()
} = {}) {
  const env = loadEnv({ env: { ...process.env, ...envOverrides } });
  const logger = createLogger({ logPath: env.logPath, now });
  const distDir = path.resolve('ui/dist');

  let apiService;
  let apiBootError = null;
  try {
    apiService = createApiService({ env, logger, now });
  } catch (error) {
    apiBootError = error;
    logger.error('api.boot.failure', { reason: error.message });
  }

  const server = createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${env.apiHost}:${env.apiPort}`);
    const pathname = parsedUrl.pathname || '/';

    if (pathname.startsWith('/api/')) {
      if (apiBootError) {
        return sendApiBootError(res, apiBootError);
      }
      const handled = apiService.handle(req, res, parsedUrl);
      if (handled !== false) {
        return;
      }
      return sendApiNotFound(res, pathname);
    }

    if (existsSync(distDir)) {
      const requested = staticPathFromRequest(distDir, pathname);
      if (serveStaticFile(res, requested)) {
        return;
      }
      if (serveStaticFile(res, path.join(distDir, 'index.html'))) {
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end('Trend OSS API is running. Build ui/ to serve dashboard.');
  });

  const close = async () => {
    if (apiService) {
      apiService.close();
    }
    if (!server.listening) {
      return;
    }
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  return {
    server,
    env,
    logger,
    close,
    hasApiBootError: Boolean(apiBootError)
  };
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    smoke: args.has('--smoke')
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const app = createAppServer();

  if (args.smoke) {
    if (app.hasApiBootError) {
      throw new Error('api_boot_failed');
    }
    app.logger.info('server.smoke.ok', {
      host: app.env.apiHost,
      port: app.env.apiPort,
      dbPath: app.env.runtimeDbPath
    });
    await app.close();
    return;
  }

  await new Promise((resolve, reject) => {
    app.server.listen(app.env.apiPort, app.env.apiHost, () => {
      app.logger.info('server.start', {
        host: app.env.apiHost,
        port: app.env.apiPort,
        readOnly: app.env.apiReadOnly
      });
      resolve();
    });
    app.server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
