const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

function isRetryableError(error) {
  if (error?.name === 'AbortError') {
    return true;
  }
  return Boolean(error?.retryable);
}

export async function fetchWithRetry(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 10000,
    retries = 2,
    backoffMs = 400,
    fetchImpl = fetch,
    logger,
    eventName = 'http.request'
  } = options;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptNumber = attempt + 1;
    const maxAttempts = retries + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }

      if (logger) {
        logger.info(`${eventName}.success`, {
          url,
          method,
          attempt: attemptNumber,
          status: response.status
        });
      }

      return response;
    } catch (error) {
      clearTimeout(timeout);

      if (logger) {
        logger.error(`${eventName}.failure`, {
          url,
          method,
          attempt: attemptNumber,
          maxAttempts,
          reason: error.message,
          status: error.status || null
        });
      }

      const retryable = isRetryableError(error);
      const shouldRetry = attempt < retries && retryable;
      if (!shouldRetry) {
        throw error;
      }

      const delay = backoffMs * (2 ** attempt);
      await sleep(delay);
    }
  }

  throw new Error(`Exhausted retries for ${url}`);
}
