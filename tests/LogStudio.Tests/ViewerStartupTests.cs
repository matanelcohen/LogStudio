using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using LogStudio.Tool;
using Xunit;

namespace LogStudio.Tests;

public sealed class ViewerStartupTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CliUsesAStableDefaultAndAllowsExplicitAutomaticSelection(bool listenAll)
    {
        string[] command = listenAll ? new[] { "--listen-all" } : new[] { "--", "dotnet" };
        Assert.Equal(ToolOptions.DefaultPort, ToolOptions.Parse(command).Port);
        Assert.Equal(5177, ToolOptions.DefaultPort);
        Assert.Equal(0, ToolOptions.Parse(new[] { "--port", "0" }.Concat(command).ToArray()).Port);
        Assert.Equal(12345, ToolOptions.Parse(new[] { "--port", "12345" }.Concat(command).ToArray()).Port);
        Assert.Equal(0, new ConsoleLogViewerOptions().Port);
    }

    [Fact]
    public async Task ChoosingANewPortStartsAnIndependentProtectedViewer()
    {
        using TcpListener occupied = new(IPAddress.Loopback, 0);
        occupied.Start();
        int port = ((IPEndPoint)occupied.LocalEndpoint).Port;
        bool prompted = false;
        await using ConsoleLogViewer? viewer = await ViewerStartup.StartAsync(
            new ConsoleLogViewerOptions { Port = port, CaptureConsole = false, ApplicationName = "new-port", Capacity = 3 },
            CancellationToken.None,
            _ =>
            {
                prompted = true;
                return Task.FromResult(true);
            });
        Assert.True(prompted);
        Assert.NotNull(viewer);
        Assert.NotEqual(port, viewer.Url.Port);
        Assert.Equal("127.0.0.1", viewer.Url.Host);
        viewer.Record("captured");
        Assert.Equal("captured", Assert.Single(viewer.GetLogs()).Message);
        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(viewer.Url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using HttpResponseMessage root = await client.GetAsync(viewer.Url.GetLeftPart(UriPartial.Authority));
        Assert.Equal(HttpStatusCode.OK, root.StatusCode);
        using HttpRequestMessage crossOrigin = new(HttpMethod.Get, viewer.Url);
        crossOrigin.Headers.Add(ViewerConstants.OriginHeader, "https://example.invalid");
        using HttpResponseMessage denied = await client.SendAsync(crossOrigin);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Equal(port, ((IPEndPoint)occupied.LocalEndpoint).Port);
    }

    [Fact]
    public async Task ChoosingAlreadyRunningDoesNotStartAViewer()
    {
        await using ConsoleLogViewer existing = CaptureTests.StartServer();
        bool prompted = false;
        await using ConsoleLogViewer? viewer = await ViewerStartup.StartAsync(
            new ConsoleLogViewerOptions { Port = existing.Url.Port, CaptureConsole = false },
            CancellationToken.None,
            _ =>
            {
                prompted = true;
                return Task.FromResult(false);
            });
        Assert.True(prompted);
        Assert.Null(viewer);
        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(existing.Url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AnAvailableExplicitPortCanBeReusedWithoutPrompting()
    {
        int port;
        await using (ConsoleLogViewer initial = CaptureTests.StartServer()) port = initial.Url.Port;
        for (int run = 0; run < 2; run++)
        {
            await using ConsoleLogViewer? viewer = await ViewerStartup.StartAsync(
                new ConsoleLogViewerOptions { Port = port, CaptureConsole = false },
                CancellationToken.None,
                _ => throw new InvalidOperationException("An available port must not prompt."));
            Assert.NotNull(viewer);
            Assert.Equal(port, viewer.Url.Port);
        }
    }

    [Fact]
    public async Task ExplicitAutomaticSelectionDoesNotPrompt()
    {
        await using ConsoleLogViewer? viewer = await ViewerStartup.StartAsync(
            new ConsoleLogViewerOptions { Port = 0, CaptureConsole = false },
            CancellationToken.None,
            _ => throw new InvalidOperationException("Automatic port selection must not prompt."));
        Assert.NotNull(viewer);
        Assert.InRange(viewer.Url.Port, 1, 65535);
    }

    [Fact]
    public async Task CancellationAtThePromptDoesNotStartAnotherViewer()
    {
        using TcpListener occupied = new(IPAddress.Loopback, 0);
        occupied.Start();
        using CancellationTokenSource cancellation = new();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ViewerStartup.StartAsync(
            new ConsoleLogViewerOptions { Port = ((IPEndPoint)occupied.LocalEndpoint).Port, CaptureConsole = false },
            cancellation.Token,
            _ =>
            {
                cancellation.Cancel();
                return Task.FromResult(true);
            }));
    }

    [Fact]
    public async Task InvalidOptionsAreNotTreatedAsPortConflicts()
    {
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => ViewerStartup.StartAsync(
            new ConsoleLogViewerOptions { Port = -1, CaptureConsole = false },
            CancellationToken.None,
            _ => throw new InvalidOperationException("Invalid options must not prompt.")));
    }

    [Theory]
    [InlineData(98, true)]
    [InlineData(48, true)]
    [InlineData(32, true)]
    [InlineData(183, true)]
    [InlineData(10048, true)]
    [InlineData(400, true)]
    [InlineData(5, false)]
    [InlineData(13, false)]
    [InlineData(2, false)]
    public void OnlyAddressInUseErrorsAllowAnotherPort(int errorCode, bool expected)
    {
        Assert.Equal(expected, HttpLogServer.IsAddressInUse(new HttpListenerException(errorCode)));
    }
}
