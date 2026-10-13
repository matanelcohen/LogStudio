using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using RandomFriendlyNameGenerator;

namespace LogStudio;

internal static class SessionNameGenerator
{
    private const string WordSeparator = " ";
    private const int MaximumGeneratedNameLength = 96;
    private static readonly object Gate = new();
    private static readonly HashSet<string> GeneratedNames = new(StringComparer.OrdinalIgnoreCase);

    internal static string Generate(string sessionsDirectory)
    {
        lock (Gate) return ReserveName(
            NameGenerator.Identifiers.Get(IdentifierComponents.Adjective | IdentifierComponents.Animal,
                separator: WordSeparator, lengthRestriction: MaximumGeneratedNameLength).ToLowerInvariant(), sessionsDirectory);
    }

    internal static string ReserveName(string name, string sessionsDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        name = string.Join(WordSeparator, name.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        lock (Gate)
        {
            HashSet<string> existingNames = new(GeneratedNames, StringComparer.OrdinalIgnoreCase);
            try
            {
                if (Directory.Exists(sessionsDirectory))
                {
                    foreach (string directory in Directory.EnumerateDirectories(sessionsDirectory))
                    {
                        if (!Guid.TryParseExact(Path.GetFileName(directory), "N", out _)) continue;
                        try
                        {
                            using FileStream file = new(Path.Combine(directory, "session.json"), FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
                            SavedSession? saved = JsonSerializer.Deserialize<SavedSession>(file, ViewerConstants.JsonOptions);
                            if (saved?.Session?.Name is string savedName) existingNames.Add(savedName);
                        }
                        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
                        {
                            // Unreadable saved metadata must not prevent a new capture from starting.
                        }
                    }
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // An unavailable catalog still permits ephemeral captures.
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
            candidate = name + WordSeparator + suffix.ToString(CultureInfo.InvariantCulture);
        return candidate;
    }
}
