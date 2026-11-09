type Point = { t: number; price: number; low90: number; high90: number };
type Crossing = { label: string; kind: string; projectedTime: number; level: number };

export default function ProjectionChart({ points, crossings }: { points: Point[]; crossings: Crossing[] }) {
  if (points.length < 2) return null;
  const width = 640;
  const height = 220;
  const prices = points.flatMap((point) => [point.low90, point.high90, point.price]);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const x = (index: number) => (index / (points.length - 1)) * (width - 24) + 12;
  const y = (price: number) => height - 16 - ((price - min) / span) * (height - 32);
  const line = points.map((point, index) => `${x(index)},${y(point.price)}`).join(" ");
  const band = `${points.map((point, index) => `${x(index)},${y(point.high90)}`).join(" ")} ${[...points].reverse().map((point, index) => `${x(points.length - 1 - index)},${y(point.low90)}`).join(" ")}`;
  return (
    <div data-testid="projection-chart">
      <p className="scenario-label" data-testid="scenario-label">SCENARIO — the fitted slope continued forward. Not a forecast of fact.</p>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Projected price path and uncertainty band">
        <polygon points={band} className="band" />
        <polyline points={line} className="path" />
        {crossings.filter((hit) => hit.kind === "path").slice(0, 8).map((hit, index) => {
          const nearest = points.reduce((best, point, pointIndex) => Math.abs(point.t - hit.projectedTime) < Math.abs(points[best].t - hit.projectedTime) ? pointIndex : best, 0);
          return <circle key={`${hit.label}-${index}`} cx={x(nearest)} cy={y(hit.level)} r="3.5" className="cross" />;
        })}
      </svg>
      <table className="crossing-table" data-testid="crossing-table">
        <thead><tr><th>Level</th><th>Kind</th><th>Projected time</th></tr></thead>
        <tbody>
          {crossings.slice(0, 12).map((hit, index) => (
            <tr key={`${hit.label}-${hit.kind}-${index}`}>
              <td>{hit.label}</td>
              <td>{hit.kind}</td>
              <td>{new Date(hit.projectedTime).toLocaleString()}</td>
            </tr>
          ))}
          {!crossings.length && <tr><td colSpan={3}>No crossing inside this scenario.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
