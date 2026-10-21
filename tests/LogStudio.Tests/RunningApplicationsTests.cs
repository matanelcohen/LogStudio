using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class RunningApplicationsTests
{
    [Fact]
    public async Task DiscoveryAndHistoryNeverSelectAnApplication()
    {
        FakeApplications applications = new();
        await using ConsoleLogViewer viewer = Start(applications);
        using HttpClient client = new();
        for (int index = 0; index < 2; index++)
        {
            using JsonDocument state = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, "api/applications")));
            Assert.Equal(JsonValueKind.Null, state.RootElement.GetProperty("selected").ValueKind);
            Assert.Equal(42, state.RootElement.GetProperty("applications")[0].GetProperty("processId").GetInt32());
            Assert.Equal("639112345678901234", state.RootElement.GetProperty("applications")[0].GetProperty("startedAtTicks").GetString());
        }
        using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SnapshotRoute)));
        Assert.True(snapshot.RootElement.GetProperty("status").GetProperty("listenAll").GetBoolean());
        Assert.Empty(snapshot.RootElement.GetProperty("entries").EnumerateArray());
        Assert.Equal(0, applications.SelectionCount);
    }

    [Fact]
    public async Task SelectionRequiresAnExplicitActionAndExactProcessIdentity()
    {
        FakeApplications applications = new();
        await using ConsoleLogViewer viewer = Start(applications);
        using HttpClient client = new();
        Uri url = new(viewer.Url, "api/applications?processId=42&startedAtTicks=639112345678901234");
        using HttpResponseMessage missingHeader = await client.PostAsync(url, null);
        Assert.Equal(HttpStatusCode.Forbidden, missingHeader.StatusCode);
        Assert.Equal(0, applications.SelectionCount);

        using HttpRequestMessage request = new(HttpMethod.Post, url);
        request.Headers.Add(ViewerConstants.ClearRequestHeader, "select-application");
        using HttpResponseMessage selected = await client.SendAsync(request);
        selected.EnsureSuccessStatusCode();
        Assert.Equal(1, applications.SelectionCount);
        Assert.Equal(42, applications.ProcessId);
        Assert.Equal(639112345678901234L, applications.StartedAtTicks);
    }

    [Theory]
    [InlineData("processId=0&startedAtTicks=1")]
    [InlineData("processId=-1&startedAtTicks=1")]
    [InlineData("processId=42&startedAtTicks=0")]
    [InlineData("processId=42&startedAtTicks=invalid")]
    [InlineData("processId=42")]
    [InlineData("processId=42&startedAtTicks=639112345678901234&sessionId=saved")]
    public async Task InvalidSelectionsDoNotReachTheCollector(string query)
    {
        FakeApplications applications = new();
        await using ConsoleLogViewer viewer = Start(applications);
        using HttpClient client = new();
        using HttpRequestMessage request = new(HttpMethod.Post, new Uri(viewer.Url, "api/applications?" + query));
        request.Headers.Add(ViewerConstants.ClearRequestHeader, "select-application");
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, applications.SelectionCount);
    }

    [Fact]
    public async Task SelectionPreservesOriginTokenAndMethodRestrictions()
    {
        FakeApplications applications = new();
        await using ConsoleLogViewer viewer = Start(applications);
        using HttpClient client = new();
        using HttpRequestMessage foreign = new(HttpMethod.Post, new Uri(viewer.Url, "api/applications?processId=42&startedAtTicks=1"));
        foreign.Headers.Add(ViewerConstants.ClearRequestHeader, "select-application");
        foreign.Headers.Add("Origin", "https://example.com");
        using HttpResponseMessage forbidden = await client.SendAsync(foreign);
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        using HttpResponseMessage missingToken = await client.GetAsync(new Uri(viewer.Url.GetLeftPart(UriPartial.Authority) + "/api/applications"));
        Assert.Equal(HttpStatusCode.NotFound, missingToken.StatusCode);
        using HttpResponseMessage wrongMethod = await client.PutAsync(new Uri(viewer.Url, "api/applications"), null);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, wrongMethod.StatusCode);
        Assert.Equal(0, applications.SelectionCount);
    }

    [Fact]
    public async Task WrapperDoesNotExposeApplicationSelection()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, "api/applications"));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task AttachmentFailuresReturnAConflictWithoutRecordingLogs()
    {
        FakeApplications applications = new() { FailSelection = true };
        await using ConsoleLogViewer viewer = Start(applications);
        using HttpClient client = new();
        using HttpRequestMessage request = new(HttpMethod.Post, new Uri(viewer.Url, "api/applications?processId=42&startedAtTicks=1"));
        request.Headers.Add(ViewerConstants.ClearRequestHeader, "select-application");
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("Application exited.", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Empty(viewer.GetLogs());
    }

    private static ConsoleLogViewer Start(IRunningApplications applications) => ConsoleLogViewer.Start(new ConsoleLogViewerOptions
    {
        CaptureConsole = false, ApplicationName = "Choose an app", RunningApplications = applications
    });

    private sealed class FakeApplications : IRunningApplications
    {
        public int SelectionCount { get; private set; }
        public int ProcessId { get; private set; }
        public long StartedAtTicks { get; private set; }
        public bool FailSelection { get; init; }
        public RunningApplicationsState GetState() => new([new(42, "Example.Api", 639112345678901234L)], null, null);
        public Task<RunningApplicationsState> SelectAsync(int processId, long startedAtTicks, CancellationToken cancellationToken)
        {
            if (this.FailSelection) throw new InvalidOperationException("Application exited.");
            this.SelectionCount++;
            this.ProcessId = processId;
            this.StartedAtTicks = startedAtTicks;
            return Task.FromResult(this.GetState() with { Selected = new(processId, "Example.Api", startedAtTicks) });
        }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
