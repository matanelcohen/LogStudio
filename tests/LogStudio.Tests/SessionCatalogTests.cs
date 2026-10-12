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
}
