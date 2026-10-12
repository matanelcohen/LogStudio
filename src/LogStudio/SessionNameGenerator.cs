using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using RandomFriendlyNameGenerator;

namespace LogStudio;

internal static class SessionNameGenerator
{
    private static readonly object Gate = new();
    private static readonly HashSet<string> GeneratedNames = new(StringComparer.OrdinalIgnoreCase);

    internal static string Generate(string sessionsDirectory)
    {
        lock (Gate)
        {
            string name = NameGenerator.Identifiers.Get(
                IdentifierComponents.Adjective | IdentifierComponents.Animal,
                separator: " ", lengthRestriction: 96).ToLowerInvariant();
            HashSet<string> existingNames = new(GeneratedNames, StringComparer.OrdinalIgnoreCase);
            if (Directory.Exists(sessionsDirectory))
            {
                foreach (string directory in Directory.EnumerateDirectories(sessionsDirectory))
                {
                    if (!Guid.TryParseExact(Path.GetFileName(directory), "N", out _)) continue;
                    try
                    {
                        using FileStream file = File.OpenRead(Path.Combine(directory, "session.json"));
                        SavedSession? saved = JsonSerializer.Deserialize<SavedSession>(file, ViewerConstants.JsonOptions);
                        if (saved?.Session?.Name is string savedName) existingNames.Add(savedName);
                    }
                    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
                    {
                        // Unreadable saved metadata must not prevent a new capture from starting.
                    }
                }
            }

            name = AvailableName(name, existingNames);
            GeneratedNames.Add(name);
            return name;
        }
    }

    internal static string AvailableName(string name, ISet<string> existingNames)
    {
        string candidate = name;
        for (int suffix = 2; existingNames.Contains(candidate); suffix++)
            candidate = name + " " + suffix.ToString(CultureInfo.InvariantCulture);
        return candidate;
    }
}
