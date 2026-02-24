function buildError(status, message) {
  return new Error(`API ${status}: ${message}`);
}

async function readJson(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error?.message || response.statusText || 'request_failed';
    throw buildError(response.status, message);
  }

  if (!payload?.ok) {
    throw buildError(response.status, payload?.error?.message || 'not_ok_payload');
  }

  return payload;
}

export async function fetchTopRepos() {
  const response = await fetch('/api/repos/top?limit=20&windowHours=24', {
    headers: { Accept: 'application/json' }
  });
  return readJson(response);
}

export async function fetchAlerts() {
  const response = await fetch('/api/alerts?limit=50', {
    headers: { Accept: 'application/json' }
  });
  return readJson(response);
}

export async function fetchSourceHealth() {
  const response = await fetch('/api/sources/health', {
    headers: { Accept: 'application/json' }
  });
  return readJson(response);
}

export async function fetchApiHealth() {
  const response = await fetch('/api/health', {
    headers: { Accept: 'application/json' }
  });
  return readJson(response);
}
