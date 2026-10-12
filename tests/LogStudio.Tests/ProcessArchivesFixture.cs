using System;
using System.IO;

namespace LogStudio.Tests;

public sealed class ProcessArchivesFixture : IDisposable
{
    private static readonly string[] Files = { "entries.jsonl", "entries.idx", "session.json", "session.json.pending" };
    internal static string Root { get; } = Directory.CreateTempSubdirectory("logstudio-process-archive-test-").FullName;

    public void Dispose()
    {
        foreach (string directory in Directory.GetDirectories(Root))
        {
            foreach (string file in Files) File.Delete(Path.Combine(directory, file));
            Directory.Delete(directory);
        }
        Directory.Delete(Root);
    }
}
