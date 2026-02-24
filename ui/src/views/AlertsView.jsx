function formatNumber(value) {
  return new Intl.NumberFormat('ko-KR').format(Number(value) || 0);
}

export default function AlertsView({ items = [] }) {
  return (
    <section className="panel">
      <h2>Alerts</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Repo</th>
              <th>Score</th>
              <th>Target</th>
              <th>Critical</th>
              <th>Sent At</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-cell">
                  알림 기록이 없습니다.
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.repoId}</td>
                <td>{formatNumber(row.score)}</td>
                <td>{row.sentTo}</td>
                <td>
                  <span className={row.isCritical ? 'badge critical' : 'badge normal'}>
                    {row.isCritical ? 'CRITICAL' : 'TREND'}
                  </span>
                </td>
                <td>{row.sentAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
