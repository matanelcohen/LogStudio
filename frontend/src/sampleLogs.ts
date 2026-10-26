import type { LogEntry } from "./model";

export const SampleSessionName = "Demo — synthetic logs";
const entries: LogEntry[] = [
  { id: 1, timestamp: "2026-01-01T12:00:00Z", stream: "stdout", severity: "information", category: "Demo.Startup", message: "[DEMO] Synthetic storefront started. No real application or customer data.", isPartial: false },
  { id: 2, timestamp: "2026-01-01T12:00:01Z", stream: "stdout", severity: "debug", category: "Demo.Orders", message: "[DEMO] Loading synthetic order 42.", isPartial: false },
  { id: 3, timestamp: "2026-01-01T12:00:02Z", stream: "stdout", severity: "warning", category: "Demo.Inventory", message: "[DEMO] Inventory lookup slow for synthetic order 42.", isPartial: false },
  { id: 4, timestamp: "2026-01-01T12:00:03Z", stream: "stderr", severity: "error", category: "Demo.Orders", message: "[DEMO] Payment timeout for synthetic order 42. Retrying locally.", isPartial: false },
  { id: 5, timestamp: "2026-01-01T12:00:04Z", stream: "stdout", severity: "information", category: "Demo.Orders", message: "[DEMO] Retry succeeded for synthetic order 42.", isPartial: false },
  { id: 6, timestamp: "2026-01-01T12:00:05Z", stream: "stdout", severity: "information", category: "Demo.Startup", message: "[DEMO] Sample complete. Search for timeout or filter by Warning and Error.", isPartial: false }
];

export function sampleLogsFile(): File {
  return new File([entries.map(entry => JSON.stringify(entry)).join("\n") + "\n"], "logstudio-demo.jsonl", { type: "application/octet-stream" });
}
