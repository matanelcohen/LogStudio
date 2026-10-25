import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip, TooltipContent, TooltipTrigger } from "@opensearch-project/oui";
import type { ReactElement } from "react";

const EmptySelectValue = "__all__";

export interface Choice {
  value: string;
  label: string;
}

export function SelectControl({ id, label, value, choices, disabled, onChange }: {
  id?: string;
  label: string;
  value: string;
  choices: readonly Choice[];
  disabled?: boolean;
  onChange(value: string): void;
}) {
  return (
    <Select disabled={disabled} value={value || EmptySelectValue} onValueChange={value => onChange(value === EmptySelectValue ? "" : value)}>
      <SelectTrigger id={id} className="select-trigger" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent className="select-content" position="popper" sideOffset={5} collisionPadding={12}>
        {choices.map(choice => <SelectItem key={choice.value} value={choice.value || EmptySelectValue}>{choice.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}
