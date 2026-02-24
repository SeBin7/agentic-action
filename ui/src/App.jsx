import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchAlerts, fetchApiHealth, fetchSourceHealth, fetchTopRepos } from './api/client.js';
import TopReposView from './views/TopReposView.jsx';
import AlertsView from './views/AlertsView.jsx';
import SourceHealthView from './views/SourceHealthView.jsx';

const REFRESH_INTERVAL_MS = 30_000;
const TABS = [
  { id: 'repos', label: 'Top Repos' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'health', label: 'Source Health' }
];

function formatTs(ts) {
  if (!ts) {
    return '-';
  }
  return new Date(ts).toLocaleString('ko-KR');
}

export default function App() {
  const [activeTab, setActiveTab] = useState('repos');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [apiHealth, setApiHealth] = useState(null);
  const [topRepos, setTopRepos] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [sourceHealth, setSourceHealth] = useState([]);

  const refresh = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [healthRes, reposRes, alertsRes, sourceRes] = await Promise.all([
        fetchApiHealth(),
        fetchTopRepos(),
        fetchAlerts(),
        fetchSourceHealth()
      ]);
      setApiHealth(healthRes);
      setTopRepos(reposRes.items || []);
      setAlerts(alertsRes.items || []);
      setSourceHealth(sourceRes.items || []);
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const activeView = useMemo(() => {
    if (activeTab === 'alerts') {
      return <AlertsView items={alerts} />;
    }
    if (activeTab === 'health') {
      return <SourceHealthView items={sourceHealth} />;
    }
    return <TopReposView items={topRepos} />;
  }, [activeTab, alerts, sourceHealth, topRepos]);

  return (
    <div className="app-shell">
      <header className="hero">
        <h1>Trending OSS Dashboard</h1>
        <p>Read-only operational view for score, alerts, and source health.</p>
        <div className="meta-row">
          <span>Last Updated: {formatTs(lastUpdated)}</span>
          <span>DB: {apiHealth?.dbPath || '-'}</span>
          <button onClick={refresh} disabled={loading} type="button">
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="error-banner">API Error: {error}</div>}

      <nav className="tab-row">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'tab active' : 'tab'}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main>{activeView}</main>
    </div>
  );
}
