import * as Oui from "@opensearch-project/oui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatMeasure, graphPoints, GraphMeasures, type AnalyticsSnapshot, type GraphDefinition, type GraphPoint } from "./analytics-model";

export function AnalyticsChart({ snapshot, graph, onExplore }: {
  snapshot: AnalyticsSnapshot;
  graph: GraphDefinition;
  onExplore?(point: GraphPoint): void;
}) {
  const points = useMemo(() => graphPoints(snapshot, graph), [snapshot, graph]);
  const [hovered, setHovered] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const helpId = useId();
  useEffect(() => {
    const element = host.current!;
    const resize = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setWidth(Math.max(240, Math.floor(width)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const maximum = Math.max(1, ...points.map(point => point.value));
  const measure = GraphMeasures.find(choice => choice.value === graph.measure)!.label;
  const selected = hovered === null ? null : points[hovered];
  const plotWidth = width - 78;
  const x = (index: number) => 62 + (index + 0.5) / Math.max(1, points.length) * plotWidth;
  const barWidth = Math.min(20, plotWidth / Math.max(1, points.length) * 0.7);
  const y = (value: number) => 218 - value / maximum * 180;
  const describe = (point: GraphPoint) => `${point.label}: ${formatMeasure(point.value, graph.measure)}`;
  const axisTime = (timestamp: string) => width < 600 ? new Date(timestamp).toLocaleTimeString() : new Date(timestamp).toLocaleString();
  return <div className="analytics-chart" ref={host}>
    {!points.length ? <p className="analytics-empty" role="status">No matching records for this graph.</p> : <>
      <p className="analytics-chart-measure">{measure}</p>
      {graph.groupBy === "time" ? <svg viewBox={`0 0 ${width} 260`} height={260} className="analytics-time-chart" role="img" aria-label={`${graph.name}: ${measure} by time`} aria-describedby={helpId}>
        {[0, 0.5, 1].map(fraction => <g key={fraction}>
          <line x1="62" x2={width - 16} y1={y(maximum * fraction)} y2={y(maximum * fraction)} className="analytics-grid-line" />
          <text x="54" y={y(maximum * fraction) + 4} textAnchor="end">{formatMeasure(maximum * fraction, graph.measure)}</text>
        </g>)}
        {graph.chartType === "line" && <polyline points={points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ")} className="analytics-line" />}
        {points.map((point, index) => <g key={index} tabIndex={0} role="graphics-symbol" aria-label={describe(point)}
          onFocus={() => setHovered(index)} onBlur={() => setHovered(null)} onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)}>
          <title>{describe(point)}</title>
          {graph.chartType === "bar" ? <rect x={x(index) - barWidth / 2} y={y(point.value)} width={barWidth} height={Math.max(1, 218 - y(point.value))} className="analytics-bar" /> :
            <circle cx={x(index)} cy={y(point.value)} r={hovered === index ? 6 : 4} className="analytics-dot" />}
        </g>)}
        <text x="62" y="246">{snapshot.firstTimestamp && axisTime(snapshot.firstTimestamp)}</text>
        <text x={width - 16} y="246" textAnchor="end">{snapshot.lastTimestamp && axisTime(snapshot.lastTimestamp)}</text>
      </svg> : <div className="analytics-category-chart" role="list" aria-label={`${graph.name}: ${measure}`}>
        {points.map((point, index) => <div className="analytics-category-row" role="listitem" key={index}>
          <span title={point.label}>{point.label}</span>
          <div className="analytics-category-track"><div style={{ width: `${point.value / maximum * 100}%` }} /></div>
          <strong>{formatMeasure(point.value, graph.measure)}</strong>
        </div>)}
      </div>}
      <p id={helpId} className="muted analytics-chart-help" aria-live="polite">{selected ? describe(selected) :
        graph.groupBy === "time" ? "32 equal-duration intervals, including quiet periods. Hover or tab to inspect a point." : "Each bar represents a distinct group of matching log records."}</p>
      <details className="analytics-data-table"><summary>View data table ({points.length} {graph.groupBy === "time" ? "intervals" : "groups"})</summary>
        <Oui.Table><Oui.TableCaption>{graph.name} · {measure}</Oui.TableCaption>
          <Oui.TableHeader><Oui.TableRow><Oui.TableHead scope="col">{graph.groupBy === "time" ? "Capture interval" : "Group"}</Oui.TableHead><Oui.TableHead scope="col">{measure}</Oui.TableHead>
            {onExplore && graph.groupBy !== "time" && <Oui.TableHead scope="col">Explore</Oui.TableHead>}</Oui.TableRow></Oui.TableHeader>
          <Oui.TableBody>{points.map((point, index) => <Oui.TableRow key={index}><Oui.TableCell>{point.label}</Oui.TableCell>
            <Oui.TableCell>{formatMeasure(point.value, graph.measure)}</Oui.TableCell>
            {onExplore && graph.groupBy !== "time" && <Oui.TableCell>{!point.other &&
              <Oui.Button variant="ghost" size="sm" onClick={() => onExplore(point)} aria-label={`Discover ${point.label}`}>Discover logs</Oui.Button>}</Oui.TableCell>}
          </Oui.TableRow>)}</Oui.TableBody>
        </Oui.Table>
      </details>
    </>}
  </div>;
}
