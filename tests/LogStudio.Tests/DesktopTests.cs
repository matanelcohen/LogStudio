using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading.Tasks;
using LogStudio.Desktop;
using LogStudio.Tool;
using Xunit;
using DesktopProgram = LogStudio.Desktop.Program;

namespace LogStudio.Tests;

public sealed class DesktopTests
{
    [Fact]
    public void DesktopDefaultsToListenAllWithoutChangingCliDefaults()
    {
        ToolOptions options = DesktopOptions.Parse([]);
        Assert.True(options.ListenAll);
        Assert.False(options.OpenBrowser);
        Assert.Equal(ToolOptions.DefaultPort, options.Port);
        Assert.Empty(options.Command);
        Assert.Throws<ArgumentException>(() => ToolOptions.Parse([]));
        Assert.False(ToolOptions.Parse(["--", "dotnet", "--info"]).ListenAll);
    }

    [Theory]
    [InlineData("--help")]
    [InlineData("-h")]
    [InlineData("--version")]
    public void DesktopSupportsHeadlessInformationOptions(string argument)
    {
        ToolOptions options = DesktopOptions.Parse([argument]);
        Assert.True(options.Help || options.Version);
    }

    [Theory]
    [InlineData("--open")]
    [InlineData("--no-wait")]
    [InlineData("--", "dotnet")]
    [InlineData("--unknown")]
    public void DesktopDoesNotWrapCommandsOrLaunchAnExternalBrowser(params string[] args)
    {
        Assert.Throws<ArgumentException>(() => DesktopOptions.Parse(args));
    }

    [Fact]
    public async Task DesktopStartsProtectedListenAllServerAndSavesOnClose()
    {
        string directory = Path.Combine(Path.GetTempPath(), "logstudio-desktop-test-" + Guid.NewGuid().ToString("N"));
        TextWriter originalOut = Console.Out;
        try
        {
            DesktopSession session = await DesktopSession.StartAsync(
                DesktopOptions.Parse(["--port", "0", "--name", "desktop-test"]), directory);
            await using (session)
            {
                Assert.Same(originalOut, Console.Out);
                using HttpClient client = new() { BaseAddress = session.Viewer.Url };
                using HttpResponseMessage applications = await client.GetAsync("api/applications");
                applications.EnsureSuccessStatusCode();
                using JsonDocument state = JsonDocument.Parse(await applications.Content.ReadAsStringAsync());
                Assert.Equal(JsonValueKind.Null, state.RootElement.GetProperty("selected").ValueKind);
                using HttpRequestMessage request = new(HttpMethod.Get, "api/applications");
                request.Headers.Add("Origin", "https://example.invalid");
                using HttpResponseMessage forbidden = await client.SendAsync(request);
                Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
                session.Viewer.Record("saved from desktop");
            }

            await session.DisposeAsync();
            Assert.Throws<ObjectDisposedException>(() => session.Viewer.Record("closed"));
            Assert.NotEmpty(Directory.GetFiles(directory, "*", SearchOption.AllDirectories));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task DesktopFallsBackFromAnOccupiedPortWithoutReadingTheConsole()
    {
        using TcpListener occupied = new(IPAddress.Loopback, 0);
        occupied.Start();
        int port = ((IPEndPoint)occupied.LocalEndpoint).Port;
        string directory = Path.Combine(Path.GetTempPath(), "logstudio-desktop-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            await using DesktopSession session = await DesktopSession.StartAsync(
                DesktopOptions.Parse(["--port", port.ToString(CultureInfo.InvariantCulture)]), directory);
            Assert.NotEqual(port, session.Viewer.Url.Port);
            Assert.Equal("127.0.0.1", session.Viewer.Url.Host);
            Assert.Equal(port, ((IPEndPoint)occupied.LocalEndpoint).Port);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void WindowLoopStaysOnCallingThreadAndAlwaysStopsServer(bool windowFails)
    {
        int thread = Environment.CurrentManagedThreadId;
        Uri? url = null;
        string directory = Path.Combine(Path.GetTempPath(), "logstudio-desktop-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            void ShowWindow(Uri address, Action shutdown)
            {
                url = address;
                Assert.Equal(thread, Environment.CurrentManagedThreadId);
                if (windowFails) throw new InvalidOperationException("native window failed");
            }

            if (windowFails)
            {
                Assert.Throws<InvalidOperationException>(() =>
                    DesktopProgram.Run(DesktopOptions.Parse(["--port", "0"]), ShowWindow, directory));
            }
            else
            {
                DesktopProgram.Run(DesktopOptions.Parse(["--port", "0"]), ShowWindow, directory);
            }

            Assert.NotNull(url);
            using TcpListener released = new(IPAddress.Loopback, url.Port);
            released.Start();
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void NativeTerminationSavesAndStopsSessionBeforeReturningFromWindowLoop()
    {
        string directory = Path.Combine(Path.GetTempPath(), "logstudio-desktop-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            DesktopProgram.Run(DesktopOptions.Parse(["--port", "0"]), (url, shutdown) =>
            {
                shutdown();
                shutdown();
                using TcpListener released = new(IPAddress.Loopback, url.Port);
                released.Start();
                Assert.NotEmpty(Directory.GetFiles(directory, "*", SearchOption.AllDirectories));
            }, directory);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }
}
