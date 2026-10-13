import type { TelemetryTag } from "./telemetry-api";
import { displayText } from "./telemetry-model";

export function TelemetryTags({ tags, compact = false }: { tags: TelemetryTag[]; compact?: boolean }) {
  return <><dl className={`telemetry-tags${compact ? " telemetry-tag-chips" : ""}`}>{tags.slice(0, 32).map((tag, index) =>
    <div key={index}><dt>{displayText(tag.key)}</dt><dd>{displayText(tag.value)}</dd></div>)}</dl>
    {tags.length > 32 && <p className="muted">Showing 32 of {tags.length} tags.</p>}</>;
}
