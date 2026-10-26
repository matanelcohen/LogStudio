import { boolean, count, nullableText, object, text } from "./apiValues";
import {
  ConditionFields, ConditionModes, ConditionOperators, IncludeModes, readChoice, Severities, Streams,
  validateConditions, validateTimeRange, type SessionFilters
} from "./model";

export function readSessionFilters(value: unknown): SessionFilters {
  const data = object(value);
  if (data.levels !== null && (!Array.isArray(data.levels) || data.levels.length > Severities.length))
    throw new Error("The server returned invalid saved levels.");
  if (!Array.isArray(data.conditions)) throw new Error("The server returned invalid saved conditions.");
  const conditions = data.conditions.map(value => {
    const condition = object(value);
    return {
      mode: readChoice(text(condition.mode, "condition mode"), ConditionModes),
      field: readChoice(text(condition.field, "condition field"), ConditionFields),
      operator: readChoice(text(condition.operator, "condition operator"), ConditionOperators),
      value: text(condition.value, "condition value")
    };
  });
  if (validateConditions(conditions)) throw new Error("The server returned invalid saved conditions.");
  const search = text(data.search, "saved search");
  const category = text(data.category, "saved category");
  if (search.length > 1024) throw new Error("The server returned an oversized saved search.");
  if (category) {
    const label = nullableText(JSON.parse(category), "saved category");
    if (label !== null && label.length > 512) throw new Error("The server returned an oversized saved category.");
  }
  const timeWindow = count(data.timeWindow, "saved time window");
  if (![0, 60000, 300000, 900000].includes(timeWindow)) throw new Error("The server returned an invalid saved time window.");
  const since = data.since === undefined ? "" : text(data.since, "saved start time");
  const until = data.until === undefined ? "" : text(data.until, "saved end time");
  if (validateTimeRange(since, until) || (timeWindow !== 0 && (since || until)))
    throw new Error("The server returned an invalid saved time range.");
  return {
    search, matchCase: boolean(data.matchCase, "saved case setting"),
    severity: readChoice(text(data.severity, "saved severity"), ["all", "warningPlus", "errorPlus", ...Severities]),
    levels: data.levels === null ? null : data.levels.map((value: unknown) => readChoice(text(value, "saved level"), Severities)),
    stream: readChoice(text(data.stream, "saved stream"), ["all", ...Streams]),
    category, timeWindow, since, until, conditions,
    includeMode: readChoice(text(data.includeMode, "saved include mode"), IncludeModes)
  };
}
