import * as Oui from "@opensearch-project/oui";
import { Filter, Hash, Search, Tags, Type } from "lucide-react";
import { useState } from "react";
import { FieldLabels, type ConditionField, type LogCondition, type LogPage } from "./model";

const Fields: { field: ConditionField; type: string }[] = [
  { field: "message", type: "text" }, { field: "category", type: "keyword" },
  { field: "level", type: "keyword" }, { field: "stream", type: "keyword" }, { field: "id", type: "number" }
];

export function DiscoverSidebar({ page, onFilter }: { page: LogPage | null; onFilter(condition: LogCondition): void }) {
  const [search, setSearch] = useState("");
  return <aside className="discover-fields" aria-label="Discover fields">
    <div className="fields-heading"><Tags size={16} /><h2>Fields</h2></div>
    <p className="muted">Local session journal</p>
    <div className="field-search"><Search size={13} /><Oui.Input aria-label="Find a field" placeholder="Find a field" value={search} onChange={event => setSearch(event.target.value)} /></div>
    <div className="field-section-label">AVAILABLE FIELDS</div>
    {Fields.filter(item => item.field.includes(search.toLowerCase())).map(item => <Oui.Button variant="ghost" size="sm" className="field-row" key={item.field}
      onClick={() => onFilter({ mode: "include", field: item.field, operator: item.field === "id" ? "equals" : "contains", value: "" })}
      title={`Add a condition on ${FieldLabels[item.field]}`}>
      {item.type === "number" ? <Hash size={13} /> : <Type size={13} />}
      <span>{item.field}</span><small>{item.type}</small><Filter size={12} />
    </Oui.Button>)}
    <div className="fields-note"><strong>{page?.entries.length ?? 0}</strong> entries loaded<br /><span>Search and export span the full journal, not only this page.</span></div>
  </aside>;
}
