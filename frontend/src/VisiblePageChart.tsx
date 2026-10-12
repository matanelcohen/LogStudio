import { useMemo } from "react";
import { TimeFormatter, type LogEntry } from "./model";

const BucketCount = 16;

export function VisiblePageChart({ entries }: { entries: LogEntry[] }) {
  const data = useMemo(() => {
    if (!entries.length) return null;
    const times = entries.map(entry => Date.parse(entry.timestamp));
    const first = Math.min(...times);
    const last = Math.max(...times);
    const span = Math.max(1, last - first);
    const buckets = Array.from({ length: BucketCount }, () => 0);
    for (const time of times) {
      const index = Math.min(BucketCount - 1, Math.floor((time - first) / span * BucketCount));
      buckets[index] = (buckets[index] ?? 0) + 1;
    }
    return { first, last, buckets, max: Math.max(...buckets) };
  }, [entries]);
  if (!data) return null;
  return <section className="page-chart" aria-label="Visible-page time distribution">
    <div className="chart-heading"><strong>Time distribution</strong><span>Visible page only · {entries.length} entries</span></div>
    <div className="chart-bars">{data.buckets.map((count, index) => <div key={index} className="chart-bar" style={{ height: `${Math.max(2, count / data.max * 100)}%` }} title={`${count} entries in this interval`} />)}</div>
    <div className="chart-times"><span>{TimeFormatter.format(new Date(data.first))}</span><span>{TimeFormatter.format(new Date(data.last))}</span></div>
  </section>;
}
