function formatNumber(value) {
  return new Intl.NumberFormat('ko-KR').format(Number(value) || 0);
}

export default function TopReposView({ items = [] }) {
  return (
    <section className="panel">
      <h2>Top Repositories</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th>Score</th>
              <th>Mentions</th>
              <th>Unique Sources</th>
              <th>Star Delta</th>
              <th>Window End</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-cell">
                  데이터가 없습니다.
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={`${row.repoId}:${row.windowEnd}`}>
                <td>
                  <a href={`https://github.com/${row.repoId}`} target="_blank" rel="noreferrer">
                    {row.repoId}
                  </a>
                </td>
                <td>{formatNumber(row.score)}</td>
                <td>{formatNumber(row.mentionCount)}</td>
                <td>{formatNumber(row.uniqueSourceCount)}</td>
                <td>{formatNumber(row.starDelta)}</td>
                <td>{row.windowEnd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
