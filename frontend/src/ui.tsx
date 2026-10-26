import { Button, Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip, TooltipContent, TooltipTrigger } from "@opensearch-project/oui";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

const EmptySelectValue = "__all__";
const CompactLayout = "(max-width: 900px), (max-height: 500px)";

export function ResponsiveActions({ label, className, children, triggerRef }: {
  label: string;
  className: string;
  children: ReactNode;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [compact, setCompact] = useState(() => matchMedia(CompactLayout).matches);
  const [open, setOpen] = useState(false);
  const actionClosing = useRef(false);
  useEffect(() => {
    const media = matchMedia(CompactLayout);
    const update = () => { setCompact(media.matches); setOpen(false); };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (!compact) return <div className={className}>{children}</div>;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button ref={triggerRef} variant="outline" size="sm">{label}<ChevronDown size={13} /></Button></PopoverTrigger>
    <PopoverContent className="popover action-disclosure" aria-label={label} sideOffset={6} align="end" collisionPadding={12}
      onCloseAutoFocus={event => {
        if (actionClosing.current) event.preventDefault();
        actionClosing.current = false;
      }}
      onClick={event => {
        if (event.target instanceof Element && event.target.closest("[data-disclosure-close]")) {
          actionClosing.current = true;
          setOpen(false);
        }
      }}>
      <div className={className}>{children}</div>
    </PopoverContent>
  </Popover>;
}

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
