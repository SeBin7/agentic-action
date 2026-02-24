function fmt(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  return value;
}

export default function SourceHealthView({ items = [] }) {
  return (
    <section className="panel">
      <h2>Source Health</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Success</th>
              <th>Failure</th>
              <th>RateLimit Streak</th>
              <th>Disabled</th>
              <th>Last Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-cell">
                  source health 데이터가 없습니다.
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={row.source}>
                <td>{row.source}</td>
                <td>{row.successCount}</td>
                <td>{row.failureCount}</td>
                <td>{row.consecutiveRateLimitFailures}</td>
                <td>
                  <span className={row.isDisabled ? 'badge critical' : 'badge normal'}>
                    {row.isDisabled ? 'YES' : 'NO'}
                  </span>
                </td>
                <td>{fmt(row.lastStatus)}</td>
                <td>{fmt(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
