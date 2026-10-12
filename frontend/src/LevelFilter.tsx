import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { Severities, SeverityLabels, type Severity } from "./model";

export function LevelFilter({ value, onChange }: { value: Severity[] | null; onChange(levels: Severity[] | null): void }) {
  const label = value === null ? "All levels" : value.length === 0 ? "No levels" :
    value.length <= 3 ? value.map(level => SeverityLabels[level]).join(" + ") : `${value.length} levels`;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button id="severity" aria-label="Level" className="select-trigger" title={value?.map(level => SeverityLabels[level]).join(", ")}>
          <span>{label}</span><ChevronDown size={13} />
        </button>
      </Menu.Trigger>
      <Menu.Portal><Menu.Content className="menu-content level-menu" sideOffset={5}>
        <Menu.Label className="menu-label">Show any selected level · OR</Menu.Label>
        <Menu.CheckboxItem className="menu-item" checked={value === null}
          onSelect={event => event.preventDefault()} onCheckedChange={checked => onChange(checked ? null : [])}>
          <Menu.ItemIndicator><Check size={13} /></Menu.ItemIndicator>All levels
        </Menu.CheckboxItem>
        <Menu.Separator className="menu-separator" />
        {Severities.map(level => (
          <Menu.CheckboxItem key={level} className="menu-item" checked={value?.includes(level) ?? false}
            onSelect={event => event.preventDefault()}
            onCheckedChange={checked => {
              const current = value ?? [];
              onChange(checked ? [...current.filter(item => item !== level), level] : current.filter(item => item !== level));
            }}>
            <Menu.ItemIndicator><Check size={13} /></Menu.ItemIndicator>
            <span className={`severity-badge ${level}`}>{SeverityLabels[level]}</span>
          </Menu.CheckboxItem>
        ))}
        <Menu.Separator className="menu-separator" />
        <Menu.Item className="menu-item" onSelect={() => onChange(["warning", "error", "critical"])}>Warning and above</Menu.Item>
        <Menu.Item className="menu-item" onSelect={() => onChange(["error", "critical"])}>Error and critical</Menu.Item>
        <Menu.Item className="menu-item" onSelect={() => onChange([])}>Deselect all</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
  );
}
