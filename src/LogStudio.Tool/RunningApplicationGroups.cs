using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace LogStudio.Tool;

internal static class RunningApplicationGroups
{
    internal static RunningApplication[] Create(IEnumerable<ApplicationProcessMetadata> processes)
    {
        Dictionary<int, ApplicationProcessMetadata> byId = processes.ToDictionary(process => process.Process.ProcessId);
        Dictionary<string, List<ApplicationProcessMetadata>> groups = new(StringComparer.Ordinal);
        Dictionary<string, ApplicationProcessMetadata> roots = new(StringComparer.Ordinal);
        foreach (ApplicationProcessMetadata process in byId.Values)
        {
            ApplicationProcessMetadata? launcher = process.IsLauncher ? process : null;
            ApplicationProcessMetadata ancestor = process;
            HashSet<int> visited = [process.Process.ProcessId];
            while (byId.TryGetValue(ancestor.ParentProcessId, out ApplicationProcessMetadata? parent) &&
                parent.Process.StartedAtTicks <= ancestor.Process.StartedAtTicks && visited.Add(parent.Process.ProcessId))
            {
                if (parent.IsLauncher) launcher = parent;
                ancestor = parent;
            }

            string key = launcher is not null ? "launch:" + Identity(launcher.Process) :
                process.Process.Path is string path ? "path:" + (OperatingSystem.IsWindows() ? path.ToUpperInvariant() : path) :
                "process:" + Identity(process.Process);
            if (!groups.TryGetValue(key, out List<ApplicationProcessMetadata>? members))
            {
                groups.Add(key, members = []);
                roots.Add(key, launcher ?? process);
            }
            members.Add(process);
        }

        return groups.Select(pair =>
        {
            ApplicationProcessMetadata root = roots[pair.Key];
            ApplicationProcessMetadata[] members = pair.Value
                .OrderBy(process => process.IsLauncher || process.IsTool)
                .ThenBy(process => root.IsLauncher ? Depth(process, root, byId) : 0)
                .ThenBy(process => process.Process.StartedAtTicks)
                .ThenBy(process => process.Process.ProcessId).ToArray();
            RunningApplicationProcess display = members[0].Process;
            RunningApplicationProcess anchor = root.IsLauncher ? root.Process : members[0].Process;
            return new RunningApplication(anchor.ProcessId, display.Name, anchor.StartedAtTicks, display.Path ?? root.Process.Path,
                pair.Key, members.Select(member => member.Process).ToArray(), members.All(member => member.IsTool));
        }).OrderBy(application => application.IsTool)
            .ThenBy(application => application.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(application => application.Path, StringComparer.Ordinal)
            .ThenBy(application => application.ProcessId).ToArray();
    }

    internal static string Identity(RunningApplicationProcess process) =>
        string.Create(CultureInfo.InvariantCulture, $"{process.ProcessId}:{process.StartedAtTicks}");

    private static int Depth(ApplicationProcessMetadata process, ApplicationProcessMetadata root,
        Dictionary<int, ApplicationProcessMetadata> byId)
    {
        int depth = 0;
        while (process.Process.ProcessId != root.Process.ProcessId && depth <= byId.Count &&
            byId.TryGetValue(process.ParentProcessId, out ApplicationProcessMetadata? parent))
        {
            process = parent;
            depth++;
        }
        return depth;
    }
}
