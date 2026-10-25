import * as Oui from "@opensearch-project/oui";

import { ArrowRight, Filter, Plus, Regex, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ConditionFields, ConditionModes, ConditionOperators, FieldLabels, IncludeModes, MaximumConditions,
  MaximumConditionValueLength, OperatorLabels, readChoice, validateConditions,
  type IncludeMode, type LogCondition
} from "./model";
import { SelectControl } from "./ui";

interface Draft {
  key: string;
  condition: LogCondition;
}

const EmptyCondition: LogCondition = { mode: "include", field: "message", operator: "contains", value: "" };
const draft = (condition: LogCondition): Draft => ({ key: crypto.randomUUID(), condition: { ...condition } });

export function ConditionDialog({ open, conditions, includeMode, seed, onClose, onApply, returnFocus }: {
  open: boolean;
  conditions: LogCondition[];
  includeMode: IncludeMode;
  seed: LogCondition | null;
  onClose(): void;
  onApply(conditions: LogCondition[], includeMode: IncludeMode): void;
  returnFocus?(): void;
}) {
  const [rows, setRows] = useState<Draft[]>([]);
  const [mode, setMode] = useState<IncludeMode>(includeMode);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const rows = conditions.map(draft);
    if (seed && rows.length < MaximumConditions) rows.push(draft(seed));
    if (!rows.length) rows.push(draft(EmptyCondition));
    setRows(rows);
    setMode(includeMode);
    setError(null);
  }, [open, conditions, includeMode, seed]);

  function update(index: number, condition: LogCondition) {
    setRows(rows => rows.map((row, current) => current === index ? { ...row, condition } : row));
    setError(null);
  }

  return (
    <Oui.Dialog open={open} onOpenChange={open => { if (!open) onClose(); }}>

        <Oui.DialogContent showCloseButton={false} id="conditionsPanel" className="condition-dialog" onCloseAutoFocus={event => {
          if (!returnFocus) return;
          event.preventDefault();
          returnFocus();
        }}>
          <div className="dialog-titlebar">
            <div className="dialog-icon"><Filter size={20} /></div>
            <div>
              <Oui.DialogTitle>Build your query</Oui.DialogTitle>
              <Oui.DialogDescription>Include the signals you need. Exclude the noise. Original history stays intact.</Oui.DialogDescription>
            </div>
            <Oui.DialogClose asChild><Oui.Button variant="ghost" size="sm" className="icon-button" aria-label="Close condition builder"><X size={18} /></Oui.Button></Oui.DialogClose>
          </div>
          <form id="conditionForm" onSubmit={event => {
            event.preventDefault();
            const conditions = rows.map(row => row.condition);
            const error = validateConditions(conditions);
            if (error) return setError(error);
            onApply(conditions, mode);
          }}>
            <div className="condition-logic">
              <span className="field-label">Include matching</span>
              <SelectControl id="includeMode" label="Include matching" value={mode} choices={[
                { value: "all", label: "All conditions · AND" }, { value: "any", label: "Any condition · OR" }
              ]} onChange={value => setMode(readChoice(value, IncludeModes))} />
              <span className="muted">Any matching exclusion wins.</span>
            </div>
            <div className="condition-list" id="conditionRows">
              {rows.map(({ key, condition }, index) => (
                <div className={`condition-row ${condition.mode}`} key={key}>
                  <span className="condition-number">{index + 1}</span>
                  <SelectControl label={`Condition ${index + 1} mode`} value={condition.mode}
                    choices={ConditionModes.map(value => ({ value, label: value === "include" ? "Include" : "Exclude" }))}
                    onChange={value => update(index, { ...condition, mode: readChoice(value, ConditionModes) })} />
                  <SelectControl label={`Condition ${index + 1} field`} value={condition.field}
                    choices={ConditionFields.map(value => ({ value, label: FieldLabels[value] }))}
                    onChange={value => update(index, { ...condition, field: readChoice(value, ConditionFields) })} />
                  <SelectControl label={`Condition ${index + 1} operator`} value={condition.operator}
                    choices={ConditionOperators.map(value => ({ value, label: OperatorLabels[value] }))}
                    onChange={value => update(index, { ...condition, operator: readChoice(value, ConditionOperators) })} />
                  <Oui.Input aria-label={`Condition ${index + 1} value`} name="value" value={condition.value}
                    maxLength={MaximumConditionValueLength} autoComplete="off" spellCheck={false}
                    placeholder={condition.operator === "regex" ? "^pattern.*$" : "Enter a value…"}
                    onChange={event => update(index, { ...condition, value: event.target.value })} />
                  <Oui.Button variant="ghost" size="icon" type="button" className="icon-button" aria-label={`Remove condition ${index + 1}`}
                    onClick={() => setRows(rows => rows.filter(row => row.key !== key))}><Trash2 size={15} /></Oui.Button>
                </div>
              ))}
            </div>
            <div className="condition-add-row">
              <Oui.Button variant="ghost" size="sm" id="addCondition" type="button" className="ghost-button" disabled={rows.length >= MaximumConditions}
                onClick={() => setRows(rows => [...rows, draft(EmptyCondition)])}><Plus size={15} /> Add condition</Oui.Button>
              <span className="muted">{rows.length} / {MaximumConditions} conditions</span>
            </div>
            {error && <Oui.Alert variant="destructive" id="conditionError" className="notice danger" role="alert">{error}</Oui.Alert>}
            <div className="regex-guidance"><Regex size={16} /><span>Regex uses linear-time matching. Lookarounds and backreferences aren’t supported.</span></div>
            <div className="dialog-footer">
              <Oui.Button variant="outline" size="sm" type="button" onClick={onClose}>Cancel</Oui.Button>
              <Oui.Button variant="default" size="sm" id="applyConditions" className="primary" type="submit">Apply conditions <ArrowRight size={15} /></Oui.Button>
            </div>
          </form>
        </Oui.DialogContent>

    </Oui.Dialog>
  );
}
