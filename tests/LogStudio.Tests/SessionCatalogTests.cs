using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class SessionCatalogTests
{
    private const string SecretValue = "synthetic-secret-value";
    private const string MetadataFileName = "session.json";
    private static readonly string[] Files = { "entries.jsonl", "entries.idx", MetadataFileName };

    [Fact]
    public async Task DefaultNamesAreUniquePerStartAndExplicitNamesArePreserved()
    {
        ConsoleLogViewerOptions options = new() { CaptureConsole = false };
        using HttpClient client = new();
        using ConsoleLogViewer first = ConsoleLogViewer.Start(options);
        using ConsoleLogViewer second = ConsoleLogViewer.Start(options);
        SessionInfo firstSession = await CurrentSession(client, first);
        SessionInfo secondSession = await CurrentSession(client, second);
        SessionNameGeneratorTests.AssertFriendlyName(firstSession.Name);
        SessionNameGeneratorTests.AssertFriendlyName(secondSession.Name);
        Assert.NotEqual(firstSession.Name, secondSession.Name);
        using JsonDocument status = JsonDocument.Parse(await client.GetStringAsync(new Uri(first.Url, ViewerConstants.SnapshotRoute)));
        Assert.Equal(firstSession.Name, status.RootElement.GetProperty("status").GetProperty("applicationName").GetString());
        Assert.Equal(firstSession.Name, (await CurrentSession(client, first)).Name);
        Assert.Null(options.ApplicationName);
        options.ApplicationName = "My investigation";
        using ConsoleLogViewer named = ConsoleLogViewer.Start(options);
        Assert.Equal(options.ApplicationName, (await CurrentSession(client, named)).Name);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CurrentRenamePersistsBeforeAndAfterCompletion(bool completeBeforeRename)
    {
        string root = Directory.CreateTempSubdirectory("logstudio-rename-test-").FullName;
        try
        {
            using HttpClient client = new();
            SessionInfo renamed;
            using (ConsoleLogViewer viewer = ConsoleLogViewer.Start(new ConsoleLogViewerOptions
            {
                CaptureConsole = false, SaveSession = true, SessionsDirectory = root,
            }))
            {
                viewer.Record("retained record");
                SessionInfo original = await CurrentSession(client, viewer);
                if (completeBeforeRename) viewer.Complete(7);
                viewer.RenameSession(" Renamed investigation ");
                renamed = await CurrentSession(client, viewer);
                Assert.Equal("Renamed investigation", renamed.Name);
                Assert.Equal(original.Id, renamed.Id);
                Assert.Equal(original.StartedAt, renamed.StartedAt);
                Assert.Equal("retained record", Assert.Single(viewer.GetLogs()).Message);
                if (!completeBeforeRename) viewer.Complete(7);
            }
            using ConsoleLogViewer current = ConsoleLogViewer.Start(new ConsoleLogViewerOptions { CaptureConsole = false, SessionsDirectory = root });
            using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(current.Url, ViewerConstants.SearchRoute + "?sessionId=" + renamed.Id)));
            Assert.Equal(renamed.Name, page.RootElement.GetProperty("status").GetProperty("applicationName").GetString());
            Assert.Equal(7, page.RootElement.GetProperty("status").GetProperty("exitCode").GetInt32());
            Assert.Equal("retained record", page.RootElement.GetProperty("entries")[0].GetProperty("message").GetString());
            using JsonDocument metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, renamed.Id, MetadataFileName)));
            Assert.Equal(renamed.Name, metadata.RootElement.GetProperty("session").GetProperty("name").GetString());
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task InvalidNamesAndDisposedViewerCannotBeRenamed()
    {
        using ConsoleLogViewer viewer = CaptureTests.StartServer();
        using HttpClient client = new();
        SessionInfo original = await CurrentSession(client, viewer);
        foreach (string name in new[] { "", "   ", new string('x', ViewerConstants.MaximumApplicationNameLength + 1) })
        {
            Assert.Throws<ArgumentException>(() => viewer.RenameSession(name));
            Assert.Throws<ArgumentException>(() => new ConsoleLogViewerOptions { ApplicationName = name }.Validate());
        }
        Assert.Equal(original.Name, (await CurrentSession(client, viewer)).Name);
        viewer.Dispose();
        Assert.Throws<ObjectDisposedException>(() => viewer.RenameSession("After disposal"));
    }

    [Fact]
    public async Task SavedSessionSurvivesViewerRestartAndRetainsRunDetails()
    {
        string root = Directory.CreateTempSubdirectory("logstudio-session-test-").FullName;
        try
        {
            ConsoleLogViewerOptions options = new()
            {
                CaptureConsole = false,
                SaveSession = true,
                SessionsDirectory = root,
                ApplicationName = "Named first run",
                RunCommand = "dotnet",
                RunArguments = new[] { "run", "--project=First.csproj", "--token=" + SecretValue },
                RunWorkingDirectory = "/synthetic/working-directory",
            };
            using (ConsoleLogViewer first = ConsoleLogViewer.Start(options))
            {
                first.Record("old first record");
                first.Record("old second record", severity: LogSeverity.Error);
                first.Complete(7);
            }

            await using ConsoleLogViewer current = ConsoleLogViewer.Start(new ConsoleLogViewerOptions
            {
                CaptureConsole = false,
                SessionsDirectory = root,
                ApplicationName = "Current run",
            });
            current.Record("current record");
            using HttpClient client = new();
            using JsonDocument sessions = JsonDocument.Parse(await client.GetStringAsync(new Uri(current.Url, ViewerConstants.SessionsRoute)));
            JsonElement old = sessions.RootElement.EnumerateArray().Single(entry => !entry.GetProperty("isCurrent").GetBoolean());
            string id = old.GetProperty("id").GetString() ?? throw new InvalidOperationException("Saved session ID missing.");
            Assert.Equal("Named first run", old.GetProperty("name").GetString());
            Assert.Equal("dotnet", old.GetProperty("command").GetString());
            Assert.Equal("/synthetic/working-directory", old.GetProperty("workingDirectory").GetString());
            Assert.Equal(7, old.GetProperty("exitCode").GetInt32());
            Assert.Contains("[redacted]", old.GetProperty("arguments")[2].GetString(), StringComparison.Ordinal);
            Assert.DoesNotContain(SecretValue, await client.GetStringAsync(new Uri(current.Url, ViewerConstants.SessionsRoute)), StringComparison.Ordinal);
            using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(current.Url, ViewerConstants.SearchRoute + "?sessionId=" + id)));
            Assert.Equal(2, page.RootElement.GetProperty("matchCount").GetInt64());
            Assert.Equal("old first record", page.RootElement.GetProperty("entries")[0].GetProperty("message").GetString());
            string export = await client.GetStringAsync(new Uri(current.Url, ViewerConstants.ExportRoute + "?sessionId=" + id));
            Assert.Contains("old second record", export, StringComparison.Ordinal);
            using HttpRequestMessage clear = new(HttpMethod.Post, new Uri(current.Url, ViewerConstants.ClearRoute + "?sessionId=" + id));
            clear.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.ClearRequestAction);
            using HttpResponseMessage cleared = await client.SendAsync(clear);
            cleared.EnsureSuccessStatusCode();
            Assert.Equal("current record", Assert.Single(current.GetLogs()).Message);
            using JsonDocument empty = JsonDocument.Parse(await client.GetStringAsync(new Uri(current.Url, ViewerConstants.SearchRoute + "?sessionId=" + id)));
            Assert.Empty(empty.RootElement.GetProperty("entries").EnumerateArray());
        }
        finally
        {
            foreach (string directory in Directory.GetDirectories(root))
            {
                foreach (string file in Files) File.Delete(Path.Combine(directory, file));
                Directory.Delete(directory);
            }
            Directory.Delete(root);
        }
    }

    [Fact]
    public void SavedCommandParametersRedactCommonSecretFlags()
    {
        string[] values = SessionCatalog.RedactArguments(new[] { "--password", SecretValue, "--skill-input:AccessToken=" + SecretValue, "--project", "Safe.csproj" });
        Assert.Equal("[redacted]", values[1]);
        Assert.DoesNotContain(SecretValue, string.Join(" ", values), StringComparison.Ordinal);
        Assert.Equal("Safe.csproj", values[4]);
    }

    private static async Task<SessionInfo> CurrentSession(HttpClient client, ConsoleLogViewer viewer) =>
        (JsonSerializer.Deserialize<SessionInfo[]>(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SessionsRoute)), ViewerConstants.JsonOptions) ??
            throw new InvalidOperationException("Session list missing.")).Single(session => session.IsCurrent);
}
