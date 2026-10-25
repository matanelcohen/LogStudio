import * as Oui from "@opensearch-project/oui";

import { ChevronDown } from "lucide-react";
import { Severities, SeverityLabels, type Severity } from "./model";

export function LevelFilter({ value, onChange }: { value: Severity[] | null; onChange(levels: Severity[] | null): void }) {
  const label = value === null ? "All levels" : value.length === 0 ? "No levels" :
    value.length <= 3 ? value.map(level => SeverityLabels[level]).join(" + ") : `${value.length} levels`;
  return (
    <Oui.DropdownMenu>
      <Oui.DropdownMenuTrigger asChild>
        <Oui.Button variant="outline" size="sm" id="severity" aria-label="Level" className="select-trigger" title={value?.map(level => SeverityLabels[level]).join(", ")}>
          <span>{label}</span><ChevronDown size={13} />
        </Oui.Button>
      </Oui.DropdownMenuTrigger>
      <Oui.DropdownMenuContent className="menu-content level-menu" sideOffset={5}>
        <Oui.DropdownMenuLabel className="menu-label">Show any selected level · OR</Oui.DropdownMenuLabel>
        <Oui.DropdownMenuCheckboxItem className="menu-item" checked={value === null}
          onSelect={event => event.preventDefault()} onCheckedChange={checked => onChange(checked ? null : [])}>
          All levels
        </Oui.DropdownMenuCheckboxItem>
        <Oui.DropdownMenuSeparator className="menu-separator" />
        {Severities.map(level => (
          <Oui.DropdownMenuCheckboxItem key={level} className="menu-item" checked={value?.includes(level) ?? false}
            onSelect={event => event.preventDefault()}
            onCheckedChange={checked => {
              const current = value ?? [];
              onChange(checked ? [...current.filter(item => item !== level), level] : current.filter(item => item !== level));
            }}>

            <Oui.Badge variant="outline" className={`severity-badge ${level}`}>{SeverityLabels[level]}</Oui.Badge>
          </Oui.DropdownMenuCheckboxItem>
        ))}
        <Oui.DropdownMenuSeparator className="menu-separator" />
        <Oui.DropdownMenuItem className="menu-item" onSelect={() => onChange(["warning", "error", "critical"])}>Warning and above</Oui.DropdownMenuItem>
        <Oui.DropdownMenuItem className="menu-item" onSelect={() => onChange(["error", "critical"])}>Error and critical</Oui.DropdownMenuItem>
        <Oui.DropdownMenuItem className="menu-item" onSelect={() => onChange([])}>Deselect all</Oui.DropdownMenuItem>
      </Oui.DropdownMenuContent>
    </Oui.DropdownMenu>
  );
}
