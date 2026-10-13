import { useEffect, useId, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { MetricMeasurement } from "./telemetry-api";
import { displayText, measurementScale, recentMeasurements } from "./telemetry-model";

const axisNumber = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
const axisTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function plotData(points: MetricMeasurement[], scale: number): uPlot.AlignedData {
  // uPlot's faceted mode retains duplicate timestamps; its published types only describe aligned mode.
  return [null, [points.map(point => Date.parse(point.timestamp) / 1000), points.map(point => point.value / scale)]] as unknown as uPlot.AlignedData;
}

export function MetricChart({ metrics }: { metrics: MetricMeasurement[] }) {
  const points = useMemo(() => recentMeasurements(metrics), [metrics]);
  const scale = measurementScale(points);
  const latest = metrics.at(-1)!;
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const current = useRef({ points, scale, data: plotData(points, scale) });
  const zoomed = useRef(false);
  const keyboardIndex = useRef<number | null>(null);
  const [hovered, setHovered] = useState<MetricMeasurement | null>(null);
  const helpId = useId();

  useEffect(() => {
    current.current = { points, scale, data: plotData(points, scale) };
    keyboardIndex.current = null;
    setHovered(null);
    plot.current?.setData(current.current.data, !zoomed.current);
  }, [points, scale]);

  useEffect(() => {
    const element = host.current!;
    let width = element.getBoundingClientRect().width;
    function create() {
      if (width <= 0) return;
      const style = getComputedStyle(element);
      const color = (name: string) => style.getPropertyValue(name).trim();
      const font = `${style.fontSize} ${style.fontFamily}`;
      plot.current = new uPlot({
        mode: 2, width: Math.floor(width), height: 210,
        legend: { show: false },
        scales: {
          x: { time: true, range: (_plot, min, max) => min === max ? [min - 1, max + 1] : [min, max] },
          y: { range: (_plot, min, max) => {
            const padding = Math.max((max - min) * 0.1, 0.05);
            return [min - padding, max + padding];
          } }
        },
        series: [{}, {
          label: displayText(latest.name),
          facets: [{ scale: "x", sorted: 1 }, { scale: "y" }],
          paths: uPlot.paths.linear!(), stroke: color("--cp-accent"), width: 2,
          points: { show: true, size: 5, fill: color("--cp-surface"), stroke: color("--cp-accent") }
        }],
        axes: [
          { stroke: color("--cp-text-muted"), font, size: 38, space: 90,
            grid: { show: false }, ticks: { stroke: color("--cp-border") },
            values: (_plot, values) => values.map(value => axisTime.format(new Date(value * 1000))) },
          { stroke: color("--cp-text-muted"), font, size: 68,
            grid: { stroke: color("--cp-border"), width: 1 }, ticks: { show: false },
            values: (_plot, values) => values.map(value => {
              const raw = value * current.current.scale;
              if (!Number.isFinite(raw)) return "";
              return raw !== 0 && (Math.abs(raw) < 0.0001 || Math.abs(raw) >= 1e6) ? raw.toExponential(2) : axisNumber.format(raw);
            }) }
        ],
        cursor: {
          drag: { x: true, y: false },
          dataIdx: (chart, seriesIndex) => {
            if (seriesIndex !== 1 || (chart.cursor.left ?? -1) < 0) return null;
            const time = chart.posToVal(chart.cursor.left!, "x");
            let nearest = 0;
            let distance = Infinity;
            current.current.points.forEach((point, index) => {
              const next = Math.abs(Date.parse(point.timestamp) / 1000 - time);
              if (next < distance) { nearest = index; distance = next; }
            });
            return nearest;
          }
        },
        hooks: {
          setCursor: [chart => {
            const index = chart.cursor.idxs?.[1];
            setHovered(index == null ? null : current.current.points[index] ?? null);
          }],
          setSelect: [chart => { if (chart.select.width > 0) zoomed.current = true; }]
        }
      }, current.current.data, element);
      return plot.current;
    }
    create();
    const resize = new ResizeObserver(entries => {
      width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width;
      if (width <= 0) return;
      if (!plot.current) create();
      else plot.current.setSize({ width: Math.floor(width), height: 210 });
    });
    resize.observe(element);
    const appearance = new MutationObserver(() => {
      const window = zoomed.current ? { min: plot.current?.scales.x?.min, max: plot.current?.scales.x?.max } : null;
      plot.current?.destroy(); plot.current = null;
      const next = create();
      if (window?.min != null && window.max != null) next?.setScale("x", { min: window.min, max: window.max });
    });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => { resize.disconnect(); appearance.disconnect(); plot.current?.destroy(); plot.current = null; };
  }, [latest.name]);

  return <div className="metric-visualization">
    <div className="metric-chart" role="img" tabIndex={0}
      aria-label={`${displayText(latest.name)} raw measurements; values in table below`} aria-describedby={helpId}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const index = Math.max(0, Math.min(points.length - 1,
          (keyboardIndex.current ?? points.length - 1) + (event.key === "ArrowLeft" ? -1 : 1)));
        keyboardIndex.current = index;
        const point = points[index];
        if (point) {
          plot.current?.setCursor({ left: plot.current.valToPos(Date.parse(point.timestamp) / 1000, "x"),
            top: plot.current.valToPos(point.value / scale, "y") });
          setHovered(point);
        }
      }}>
      <div ref={host} aria-hidden="true" />
    </div>
    <div className="metric-legend">
      <span><i className="telemetry-color-key" />{displayText(latest.name)}{latest.unit && ` (${displayText(latest.unit)})`}</span>
      <button className="ghost-button" onClick={() => {
        zoomed.current = false;
        plot.current?.setData(current.current.data);
      }}>Reset zoom</button>
    </div>
    <p className="metric-hover">{hovered ? `${hovered.timestamp} · ${hovered.value} ${displayText(latest.unit ?? "")}` : "Hover a point to inspect its raw value"}</p>
    <p id={helpId} className="muted metric-help">Drag to zoom · Arrow keys inspect points · Exact values in the table below</p>
  </div>;
}
