using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class SessionNameGeneratorTests
{
    [Fact]
    public void GeneratedNamesAreFriendlyAndUniqueAcrossConcurrentStarts()
    {
        string directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        ConcurrentBag<string> names = new();
        Parallel.For(0, 512, _ => names.Add(SessionCatalog.GenerateName(directory)));
        HashSet<string> uniqueNames = new(StringComparer.Ordinal);
        foreach (string name in names)
        {
            AssertFriendlyName(name);
            Assert.True(uniqueNames.Add(name), "Generated session names must be unique.");
        }
        Assert.False(Directory.Exists(directory));
    }

    [Fact]
    public void CollidingNamesReceiveTheFirstAvailableNumericSuffix()
    {
        HashSet<string> names = new(StringComparer.OrdinalIgnoreCase) { "DIGITAL DUCK", "digital duck 2", "digital duck 4" };
        Assert.Equal("digital duck 3", SessionNameGenerator.AvailableName("digital duck", names));
        Assert.Equal("yellow bear", SessionNameGenerator.AvailableName("yellow bear", names));
    }

    [Fact]
    public void GeneratedNamesAvoidSavedNamesAndNamesAlreadyReservedInTheProcess()
    {
        string root = Directory.CreateTempSubdirectory("logstudio-name-test-").FullName;
        try
        {
            using (ConsoleLogViewer viewer = ConsoleLogViewer.Start(new ConsoleLogViewerOptions
            {
                CaptureConsole = false, SaveSession = true, SessionsDirectory = root, ApplicationName = "Digital Duck",
            }))
            {
                viewer.Record("saved session");
            }

            string first = SessionNameGenerator.ReserveName("digital duck", root);
            string second = SessionNameGenerator.ReserveName("digital duck", root);
            Assert.StartsWith("digital duck ", first, StringComparison.Ordinal);
            Assert.StartsWith("digital duck ", second, StringComparison.Ordinal);
            Assert.NotEqual(first, second);
            AssertFriendlyName(first);
            AssertFriendlyName(second);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void InvalidSavedMetadataDoesNotPreventNameGeneration()
    {
        string root = Directory.CreateTempSubdirectory("logstudio-name-test-").FullName;
        try
        {
            string directory = Directory.CreateDirectory(Path.Combine(root, Guid.NewGuid().ToString("N"))).FullName;
            File.WriteAllText(Path.Combine(directory, "session.json"), "{");
            AssertFriendlyName(SessionCatalog.GenerateName(root));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    internal static void AssertFriendlyName(string name)
    {
        Assert.Equal(name.ToLowerInvariant(), name);
        Assert.Matches(@"^\S+(?: \S+)+$", name);
        Assert.InRange(name.Length, 1, ViewerConstants.MaximumApplicationNameLength);
        Assert.DoesNotContain("session-", name, StringComparison.Ordinal);
    }
}
