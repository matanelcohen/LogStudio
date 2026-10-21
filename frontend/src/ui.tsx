import * as Select from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";
import { getNonce } from "get-nonce";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
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
    <Select.Root disabled={disabled} value={value || EmptySelectValue} onValueChange={value => onChange(value === EmptySelectValue ? "" : value)}>
      <Select.Trigger id={id} className="select-trigger" aria-label={label}>
        <Select.Value />
        <Select.Icon><ChevronDown size={13} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={5} collisionPadding={12}>
          <Select.ScrollUpButton className="select-scroll"><ChevronUp size={14} /></Select.ScrollUpButton>
          <Select.Viewport nonce={getNonce()}>
            {choices.map(choice => (
              <Select.Item key={choice.value} value={choice.value || EmptySelectValue} className="select-item">
                <Select.ItemText>{choice.label}</Select.ItemText>
                <Select.ItemIndicator><Check size={14} /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="select-scroll"><ChevronDown size={14} /></Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6}>{label}<Tooltip.Arrow /></Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
