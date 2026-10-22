using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Xunit;

namespace LogStudio.Tests;

public sealed class ProcessTests : IClassFixture<ProcessArchivesFixture>
{
    private const string DotnetCommand = "dotnet";
    private const string DemoMetadataKey = "DemoPath";
    private const string ToolMetadataKey = "ToolPath";
    private const string StartupHooksEnvironmentVariable = "DOTNET_STARTUP_HOOKS";
    private const string UrlPrefix = "Log Studio: ";
    private const string Payload = "argument with spaces = quoted value";
    private const int LongRunStepCount = 10_001;
    private static readonly TimeSpan ProcessTimeout = TimeSpan.FromSeconds(20);
    private static readonly ConcurrentDictionary<int, ConcurrentDictionary<string, byte>> HistoryDirectories = new();
    private static readonly ConcurrentDictionary<Uri, int> ViewerProcesses = new();
    private static readonly string[] HistoryFileNames = { "entries.jsonl", "entries.idx" };

    [Fact]
    public async Task SequentialWrapperRunsUseTheSameDefaultPort()
    {
        for (int run = 0; run < 2; run++)
        {
            ProcessResult result = await RunProcessAsync(new[]
            {
                ToolPath, "--no-wait", "--", DotnetCommand, DemoPath, "--count", "0", "--delay", "0",
            });
            Assert.Equal(0, result.ExitCode);
            Assert.Contains("Log Studio: http://127.0.0.1:5177/", result.Error, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OccupiedPortsWithRedirectedInputFailWithoutStartingAnything(bool listenAll)
    {
        using TcpListener occupied = new(IPAddress.Loopback, 0);
        occupied.Start();
        string port = ((IPEndPoint)occupied.LocalEndpoint).Port.ToString(CultureInfo.InvariantCulture);
        string[] arguments = listenAll
            ? new[] { "--port", port, "--listen-all" }
            : new[] { "--port", port, "--no-wait", "--", DotnetCommand, DemoPath, "--count", "0", "--interactive" };
        ProcessResult result = await RunProcessAsync(WrapperArguments(arguments), input: Payload);
        Assert.Equal(1, result.ExitCode);
        Assert.Contains($"Port {port} is already in use", result.Error, StringComparison.Ordinal);
        Assert.Contains("Log Studio may already be running", result.Error, StringComparison.Ordinal);
        Assert.Contains("--port 0", result.Error, StringComparison.Ordinal);
        Assert.DoesNotContain("[A]", result.Error, StringComparison.Ordinal);
        Assert.DoesNotContain(UrlPrefix, result.Error, StringComparison.Ordinal);
        Assert.Empty(result.Output);
    }

    [Fact]
    public async Task WrapperMirrorsStdoutStderrAndPreservesNonzeroExitCode()
    {
        ProcessResult result = await RunProcessAsync(WrapperArguments("--no-wait", "--", DotnetCommand, DemoPath, "--count", "1", "--delay", "0", "--exit-code", "7"));
        Assert.Equal(7, result.ExitCode);
        Assert.Contains("Search seed: alpha beta", result.Output, StringComparison.Ordinal);
        Assert.Contains("Error: synthetic stderr entry", result.Error, StringComparison.Ordinal);
        Assert.Contains(UrlPrefix, result.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InteractiveStandardInputPassesThroughTheWrapper()
    {
        ProcessResult result = await RunProcessAsync(
            WrapperArguments("--no-wait", "--", DotnetCommand, DemoPath, "--count", "0", "--interactive"), input: Payload);
        Assert.Equal(0, result.ExitCode);
        Assert.Contains("Input> ", result.Output, StringComparison.Ordinal);
        Assert.Contains($"Received: {Payload}", result.Output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" \t ")]
    [InlineData("日本語 café 🙂")]
    public async Task BrowserInputReachesTheWaitingChildAndIsUnavailableAfterExit(string text)
    {
        using Process process = StartProcess(WrapperArguments("--", DotnetCommand, DemoPath, "--count", "0", "--interactive"));
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string>? error = null;
        using HttpClient client = new();
        using CancellationTokenSource timeout = new(ProcessTimeout);
        try
        {
            Uri url = await ReadUrlAsync(process);
            error = process.StandardError.ReadToEndAsync();
            while (true)
            {
                using JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token);
                if (snapshot.RootElement.GetProperty("status").GetProperty("canWriteInput").GetBoolean()) break;
                await Task.Delay(20, timeout.Token);
            }
            using HttpRequestMessage request = new(HttpMethod.Post, new Uri(url, "api/input"));
            request.Headers.Add(ViewerConstants.ClearRequestHeader, "input");
            request.Content = new StringContent(JsonSerializer.Serialize(new { text }), Encoding.UTF8, "application/json");
            using HttpResponseMessage response = await client.SendAsync(request, timeout.Token);
            Encoding inputEncoding = (Encoding)process.StandardInput.Encoding.Clone();
            inputEncoding.EncoderFallback = EncoderFallback.ExceptionFallback;
            try
            {
                inputEncoding.GetByteCount(text);
            }
            catch (EncoderFallbackException)
            {
                Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
                return;
            }
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            while (true)
            {
                using JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token);
                if (snapshot.RootElement.GetProperty("status").GetProperty("isCompleted").GetBoolean())
                {
                    Assert.False(snapshot.RootElement.GetProperty("status").GetProperty("canWriteInput").GetBoolean());
                    Assert.Contains(snapshot.RootElement.GetProperty("entries").EnumerateArray(), entry =>
                        entry.GetProperty("message").GetString()?.Contains("Received: " + text, StringComparison.Ordinal) == true);
                    break;
                }
                await Task.Delay(20, timeout.Token);
            }
            using HttpRequestMessage afterExit = new(HttpMethod.Post, new Uri(url, "api/input"));
            afterExit.Headers.Add(ViewerConstants.ClearRequestHeader, "input");
            afterExit.Content = new StringContent("{\"text\":\"do not send\"}", Encoding.UTF8, "application/json");
            using HttpResponseMessage rejected = await client.SendAsync(afterExit, timeout.Token);
            Assert.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
        }
        finally
        {
            await KillAsync(process);
            await output;
            if (error is not null) await error;
        }
    }

    [Fact]
    public async Task TerminalEofClosesChildInputAndBrowserCapability()
    {
        using Process process = StartProcess(WrapperArguments("--", DotnetCommand, DemoPath, "--count", "0", "--interactive"));
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string>? error = null;
        try
        {
            Uri url = await ReadUrlAsync(process);
            error = process.StandardError.ReadToEndAsync();
            process.StandardInput.Close();
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            while (true)
            {
                using JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token);
                if (snapshot.RootElement.GetProperty("status").GetProperty("isCompleted").GetBoolean())
                {
                    Assert.False(snapshot.RootElement.GetProperty("status").GetProperty("canWriteInput").GetBoolean());
                    break;
                }
                await Task.Delay(20, timeout.Token);
            }
            using HttpRequestMessage request = new(HttpMethod.Post, new Uri(url, "api/input"));
            request.Headers.Add(ViewerConstants.ClearRequestHeader, "input");
            request.Content = new StringContent("{\"text\":\"do not send\"}", Encoding.UTF8, "application/json");
            using HttpResponseMessage response = await client.SendAsync(request, timeout.Token);
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        }
        finally
        {
            await KillAsync(process);
            Assert.DoesNotContain("do not send", await output, StringComparison.Ordinal);
            if (error is not null) await error;
        }
    }

    [Fact]
    public async Task BrowserAndTerminalCanSendSuccessiveLinesToTheSameChild()
    {
        using Process process = StartProcess(WrapperArguments("--no-wait", "--", DotnetCommand, DemoPath, "--showcase"));
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string>? error = null;
        try
        {
            Uri url = await ReadUrlAsync(process);
            error = process.StandardError.ReadToEndAsync();
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            while (true)
            {
                using JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token);
                if (snapshot.RootElement.GetProperty("status").GetProperty("canWriteInput").GetBoolean()) break;
                await Task.Delay(20, timeout.Token);
            }
            foreach (string text in new[] { "", "success" })
            {
                using HttpRequestMessage request = new(HttpMethod.Post, new Uri(url, "api/input"));
                request.Headers.Add(ViewerConstants.ClearRequestHeader, "input");
                request.Content = new StringContent(JsonSerializer.Serialize(new { text }), Encoding.UTF8, "application/json");
                using HttpResponseMessage response = await client.SendAsync(request, timeout.Token);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            }
            await process.StandardInput.WriteLineAsync("quit");
            await process.WaitForExitAsync().WaitAsync(ProcessTimeout);
            Assert.Equal(0, process.ExitCode);
            Assert.Contains("Checkout 4 completed", await output, StringComparison.Ordinal);
            await error;
        }
        finally
        {
            await KillAsync(process);
        }
    }

    [Fact]
    public async Task WrapperExitsWhenChildFinishesWhileStandardInputRemainsOpen()
    {
        using Process process = StartProcess(
            WrapperArguments("--no-wait", "--", DotnetCommand, DemoPath, "--count", "0"));
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string> error = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(ProcessTimeout);
            Assert.Equal(0, process.ExitCode);
            await output;
            await error;
        }
        finally
        {
            await KillAsync(process);
        }
    }

    [Fact]
    public async Task ShowcaseCapturesLogsNestedTracesAndMetricsUntilQuit()
    {
        using Process process = StartProcess(new[] { DemoPath, "--showcase" });
        Task<string>? output = null;
        Task<string>? error = null;
        try
        {
            Uri url = await ReadUrlAsync(process);
            output = process.StandardOutput.ReadToEndAsync();
            error = process.StandardError.ReadToEndAsync();
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            await process.StandardInput.WriteLineAsync("success");
            await process.StandardInput.WriteLineAsync("slow");
            await process.StandardInput.WriteLineAsync("error");
            await process.StandardInput.WriteLineAsync("burst");
            JsonElement telemetry;
            do
            {
                using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/telemetry"), timeout.Token));
                telemetry = snapshot.RootElement.Clone();
                if (telemetry.GetProperty("spans").GetArrayLength() >= 48 &&
                    telemetry.GetProperty("metrics").EnumerateArray().Any(metric =>
                        metric.GetProperty("name").GetString() == "demo.orders.completed" &&
                        metric.GetProperty("value").GetDouble() == 16)) break;
                await Task.Delay(20, timeout.Token);
            }
            while (true);

            Assert.False(process.HasExited);
            Assert.True(telemetry.GetProperty("enabled").GetBoolean());
            JsonElement[] spans = telemetry.GetProperty("spans").EnumerateArray().ToArray();
            Assert.Equal(16, spans.Count(span => span.GetProperty("name").GetString() == "checkout"));
            JsonElement failedOrder = spans.First(span => span.GetProperty("name").GetString() == "checkout" &&
                span.GetProperty("status").GetString() == "Error");
            Assert.Contains(spans, span => span.GetProperty("name").GetString() == "charge-payment" &&
                span.GetProperty("status").GetString() == "Error" &&
                span.GetProperty("traceId").GetString() == failedOrder.GetProperty("traceId").GetString() &&
                span.GetProperty("parentSpanId").GetString() == failedOrder.GetProperty("spanId").GetString());
            Assert.Contains(spans, span => span.GetProperty("name").GetString() == "reserve-stock" &&
                span.GetProperty("parentSpanId").GetString() == failedOrder.GetProperty("spanId").GetString());

            JsonElement[] metrics = telemetry.GetProperty("metrics").EnumerateArray().ToArray();
            foreach (string name in new[] { "demo.orders", "demo.errors", "demo.order.duration", "demo.orders.in_flight", "demo.orders.completed" })
            {
                Assert.Contains(metrics, metric => metric.GetProperty("name").GetString() == name);
            }
            Assert.Contains(metrics, metric => metric.GetProperty("name").GetString() == "demo.order.duration" &&
                metric.GetProperty("value").GetDouble() >= 600 &&
                metric.GetProperty("tags").EnumerateArray().Any(tag =>
                    tag.GetProperty("key").GetString() == "scenario" && tag.GetProperty("value").GetString() == "slow"));
            using JsonDocument logs = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, ViewerConstants.SnapshotRoute), timeout.Token));
            Assert.Contains(logs.RootElement.GetProperty("entries").EnumerateArray(), entry =>
                entry.GetProperty("message").GetString()?.Contains(failedOrder.GetProperty("traceId").GetString()!, StringComparison.Ordinal) == true);

            await process.StandardInput.WriteLineAsync("quit");
            await process.WaitForExitAsync().WaitAsync(ProcessTimeout);
            Assert.Equal(0, process.ExitCode);
            Assert.Contains("Commands: success, slow, error, burst", await output, StringComparison.Ordinal);
            await error;
        }
        finally
        {
            await KillAsync(process);
            if (output is not null) await output;
            if (error is not null) await error;
        }
    }

    [Fact]
    public async Task ShowcaseStopsOnEndOfInput()
    {
        ProcessResult result = await RunProcessAsync(new[] { DemoPath, "--showcase" });
        Assert.Equal(0, result.ExitCode);
        Assert.Contains(UrlPrefix, result.Error, StringComparison.Ordinal);
        Assert.Contains("Open the printed Log Studio URL to explore logs in Discover.", result.Output, StringComparison.Ordinal);
        Assert.DoesNotContain("select Logs, Metrics, or Traces", result.Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ShowcaseStopsOnInterruptWhileWaitingForInput()
    {
        if (OperatingSystem.IsWindows()) return;
        using Process process = StartProcess(new[] { DemoPath, "--showcase" });
        Task<string>? error = null;
        try
        {
            await ReadUrlAsync(process);
            error = process.StandardError.ReadToEndAsync();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            while (true)
            {
                string? line = await process.StandardOutput.ReadLineAsync(timeout.Token);
                Assert.NotNull(line);
                if (line.StartsWith("Commands: success", StringComparison.Ordinal)) break;
            }
            char[] prompt = new char[6];
            Assert.Equal(prompt.Length, await process.StandardOutput.ReadBlockAsync(prompt.AsMemory(), timeout.Token));
            Assert.Equal("Demo> ", new string(prompt));
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            ProcessStartInfo signalInfo = new("kill") { UseShellExecute = false };
            signalInfo.ArgumentList.Add("-s");
            signalInfo.ArgumentList.Add("INT");
            signalInfo.ArgumentList.Add(process.Id.ToString(CultureInfo.InvariantCulture));
            using Process signal = Process.Start(signalInfo)!;
            await signal.WaitForExitAsync().WaitAsync(ProcessTimeout);
            Assert.Equal(0, signal.ExitCode);
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(0, process.ExitCode);
            await output;
            await error;
        }
        finally
        {
            await KillAsync(process);
            if (error is not null) await error;
        }
    }

    [Fact]
    public async Task WrapperPreservesWorkingDirectoryAndRelativeChildPaths()
    {
        string directory = Path.GetDirectoryName(DemoPath) ??
            throw new InvalidOperationException("The demo fixture has no containing directory.");
        ProcessResult result = await RunProcessAsync(
            WrapperArguments("--no-wait", "--", DotnetCommand, Path.GetFileName(DemoPath), "--count", "0", "--delay", "0"),
            workingDirectory: directory);
        Assert.Equal(0, result.ExitCode);
        Assert.Contains($"Content root path: {directory}", result.Output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("--unknown")]
    [InlineData("--port")]
    [InlineData("--port", "abc", "--", "dotnet")]
    [InlineData("--capacity", "-1", "--", "dotnet")]
    [InlineData("--flush-every", "0", "--", "dotnet")]
    [InlineData("--flush-every", "invalid", "--", "dotnet")]
    [InlineData("--listen-all", "--no-wait")]
    [InlineData("--no-wait", "--listen-all")]
    [InlineData("--listen-all", "--", "dotnet")]
    [InlineData("--listen-all", "--")]
    [InlineData("--listen-all", "dotnet")]
    public async Task InvalidWrapperArgumentsFailExplicitly(params string[] args)
    {
        ProcessResult result = await RunProcessAsync(WrapperArguments(args));
        Assert.Equal(2, result.ExitCode);
        Assert.False(string.IsNullOrWhiteSpace(result.Error));
    }

    [Fact]
    public async Task ListenAllRequiresSelectionThenCapturesOnlyNewStructuredLogsWithoutStoppingTheTarget()
    {
        using Process process = StartProcess(WrapperArguments("--listen-all"));
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string>? error = null;
        using ILoggerFactory loggerFactory = LoggerFactory.Create(builder => builder
            .SetMinimumLevel(LogLevel.Trace)
            .AddEventSourceLogger());
        ILogger logger = loggerFactory.CreateLogger("ListenAll.ProcessTests");
        string longCategory = new('c', 600);
        ILogger longCategoryLogger = loggerFactory.CreateLogger(longCategory);
        string beforeSelection = $"before-selection-{Guid.NewGuid():N}";
        string selectedMessage = $"captured-after-selection-{Guid.NewGuid():N}";
        string categoryMessage = $"long-category-{Guid.NewGuid():N}";
        string severityPrefix = $"severity-{Guid.NewGuid():N}-";
        try
        {
            Uri url = await ReadUrlAsync(process);
            error = process.StandardError.ReadToEndAsync();
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            logger.LogWarning("{Message}", beforeSelection);
            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                Assert.True(snapshot.RootElement.GetProperty("status").GetProperty("listenAll").GetBoolean());
                Assert.Empty(snapshot.RootElement.GetProperty("entries").EnumerateArray());
            }

            JsonElement target;
            using (JsonDocument state = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), timeout.Token)))
            {
                Assert.Equal(JsonValueKind.Null, state.RootElement.GetProperty("selected").ValueKind);
                JsonElement[] applications = state.RootElement.GetProperty("applications").EnumerateArray().ToArray();
                Assert.DoesNotContain(applications, application => application.GetProperty("processId").GetInt32() == process.Id);
                target = Assert.Single(applications, application => application.GetProperty("processId").GetInt32() == Environment.ProcessId).Clone();
                Assert.False(string.IsNullOrWhiteSpace(target.GetProperty("name").GetString()));
                Assert.True(long.Parse(target.GetProperty("startedAtTicks").GetString()!, CultureInfo.InvariantCulture) > 0);
            }

            Uri selection = ApplicationSelection(url, target);
            using (HttpResponseMessage denied = await client.PostAsync(selection, null, timeout.Token))
            {
                Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            }

            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                Assert.Empty(snapshot.RootElement.GetProperty("entries").EnumerateArray());
            }

            using (JsonDocument state = await SelectApplicationAsync(client, selection, timeout.Token))
            {
                Assert.Equal(JsonValueKind.Null, state.RootElement.GetProperty("error").ValueKind);
                Assert.Equal(Environment.ProcessId, state.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }

            JsonElement captured;
            while (true)
            {
                // EventPipe publishes in batches; repeat a unique post-selection message until observed.
                logger.LogWarning("{Message}", selectedMessage);
                longCategoryLogger.LogInformation("{Message}", categoryMessage);
                foreach (LogLevel level in Enum.GetValues<LogLevel>().Where(level => level != LogLevel.None))
                {
                    logger.Log(level, "{Message}", severityPrefix + level);
                }

                using JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token);
                JsonElement[] entries = snapshot.RootElement.GetProperty("entries").EnumerateArray().ToArray();
                Assert.DoesNotContain(entries, entry => entry.GetProperty("message").GetString() == beforeSelection);
                JsonElement match = entries.FirstOrDefault(entry => entry.GetProperty("message").GetString() == selectedMessage);
                if (match.ValueKind != JsonValueKind.Undefined &&
                    entries.Any(entry => entry.GetProperty("message").GetString() == categoryMessage) &&
                    Enum.GetValues<LogLevel>().Where(level => level != LogLevel.None)
                        .All(level => entries.Any(entry => entry.GetProperty("message").GetString() == severityPrefix + level)))
                {
                    captured = match.Clone();
                    Assert.Contains(entries, entry =>
                        entry.GetProperty("message").GetString() == categoryMessage &&
                        entry.GetProperty("category").GetString() == longCategory[..512]);
                    foreach (LogLevel level in Enum.GetValues<LogLevel>().Where(level => level != LogLevel.None))
                    {
                        Assert.Contains(entries, entry =>
                            entry.GetProperty("message").GetString() == severityPrefix + level &&
                            entry.GetProperty("severity").GetString() == JsonNamingPolicy.CamelCase.ConvertName(level.ToString()));
                    }

                    break;
                }

                await Task.Delay(100, timeout.Token);
            }

            Assert.Equal("warning", captured.GetProperty("severity").GetString());
            Assert.Equal("ListenAll.ProcessTests", captured.GetProperty("category").GetString());
            using (JsonDocument unchanged = await SelectApplicationAsync(client, selection, timeout.Token))
            {
                Assert.Equal(Environment.ProcessId, unchanged.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }

            long startedAtTicks = long.Parse(target.GetProperty("startedAtTicks").GetString()!, CultureInfo.InvariantCulture);
            Uri reusedIdentity = new(url, $"api/applications?processId={Environment.ProcessId}&startedAtTicks={startedAtTicks + 1}");
            using (HttpRequestMessage staleSelection = new(HttpMethod.Post, reusedIdentity))
            {
                staleSelection.Headers.Add(ViewerConstants.ClearRequestHeader, "select-application");
                using HttpResponseMessage failed = await client.SendAsync(staleSelection, timeout.Token);
                Assert.Equal(HttpStatusCode.Conflict, failed.StatusCode);
            }

            using (JsonDocument failed = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), timeout.Token)))
            {
                Assert.False(string.IsNullOrEmpty(failed.RootElement.GetProperty("error").GetString()));
                Assert.Equal(Environment.ProcessId, failed.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }

            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                Assert.Contains(snapshot.RootElement.GetProperty("entries").EnumerateArray(),
                    entry => entry.GetProperty("message").GetString() == selectedMessage);
            }

            if (!OperatingSystem.IsWindows())
            {
                await InterruptAsync(process);
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Assert.Equal(130, process.ExitCode);
                logger.LogWarning("The external target still runs after listener shutdown.");
                using Process externalTarget = System.Diagnostics.Process.GetCurrentProcess();
                Assert.False(externalTarget.HasExited);
            }
        }
        finally
        {
            await KillAsync(process);
            await output;
            if (error is not null) await error;
        }
    }

    [Fact]
    public async Task ListenAllRestoresSeparateHistoriesOnExplicitSwitchAndDoesNotReconnectAfterTargetExit()
    {
        using Process target = StartProcess(new[] { DemoPath, "--showcase" });
        using Process listener = StartProcess(WrapperArguments("--listen-all"));
        Task<string> output = listener.StandardOutput.ReadToEndAsync();
        Task<string>? error = null;
        Task<string> targetOutput = target.StandardOutput.ReadToEndAsync();
        Task<string>? targetError = null;
        using ILoggerFactory loggerFactory = LoggerFactory.Create(builder => builder.AddEventSourceLogger());
        ILogger logger = loggerFactory.CreateLogger("ListenAll.SwitchTests");
        string marker = $"history-before-switch-{Guid.NewGuid():N}";
        string resumed = $"history-after-switch-{Guid.NewGuid():N}";
        List<string> histories = [];
        try
        {
            await ReadUrlAsync(target);
            targetError = target.StandardError.ReadToEndAsync();
            Uri url = await ReadUrlAsync(listener);
            error = listener.StandardError.ReadToEndAsync();
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(40));
            JsonElement self;
            JsonElement other;
            using (JsonDocument state = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), timeout.Token)))
            {
                JsonElement[] applications = state.RootElement.GetProperty("applications").EnumerateArray().ToArray();
                self = Assert.Single(applications, application => application.GetProperty("processId").GetInt32() == Environment.ProcessId).Clone();
                other = Assert.Single(applications, application => application.GetProperty("processId").GetInt32() == target.Id).Clone();
                Assert.Equal("LogStudio.Demo", other.GetProperty("name").GetString());
            }

            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, self), timeout.Token))
            {
                Assert.Equal(Environment.ProcessId, selected.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }

            JsonElement original;
            long firstRevision;
            while (true)
            {
                logger.LogWarning("{Message}", marker);
                using JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token);
                JsonElement match = snapshot.RootElement.GetProperty("entries").EnumerateArray()
                    .FirstOrDefault(entry => entry.GetProperty("message").GetString() == marker);
                if (match.ValueKind != JsonValueKind.Undefined)
                {
                    original = match.Clone();
                    histories.Add(snapshot.RootElement.GetProperty("status").GetProperty("historyDirectory").GetString()!);
                    firstRevision = snapshot.RootElement.GetProperty("status").GetProperty("revision").GetInt64();
                    break;
                }
                await Task.Delay(100, timeout.Token);
            }

            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, other), timeout.Token))
            {
                Assert.Equal(target.Id, selected.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }

            logger.LogInformation("This unselected process must not be captured.");
            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                Assert.Empty(snapshot.RootElement.GetProperty("entries").EnumerateArray());
                histories.Add(snapshot.RootElement.GetProperty("status").GetProperty("historyDirectory").GetString()!);
                Assert.NotEqual(histories[0], histories[1]);
                Assert.True(snapshot.RootElement.GetProperty("status").GetProperty("revision").GetInt64() > firstRevision);
            }
            JsonElement otherEntry = await CaptureDemoMessageAsync(client, url, target, target.Id, timeout.Token, includeRelated: false);
            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, self), timeout.Token))
            {
                Assert.Equal(Environment.ProcessId, selected.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }
            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                Assert.Equal(histories[0], snapshot.RootElement.GetProperty("status").GetProperty("historyDirectory").GetString());
                JsonElement restored = Assert.Single(snapshot.RootElement.GetProperty("entries").EnumerateArray(),
                    entry => entry.GetProperty("id").GetInt64() == original.GetProperty("id").GetInt64());
                Assert.Equal(original.GetRawText(), restored.GetRawText());
                Assert.DoesNotContain(snapshot.RootElement.GetProperty("entries").EnumerateArray(),
                    entry => entry.GetProperty("message").GetString() == otherEntry.GetProperty("message").GetString());
            }
            while (true)
            {
                logger.LogError("{Message}", resumed);
                using JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token);
                if (snapshot.RootElement.GetProperty("entries").EnumerateArray().Any(entry => entry.GetProperty("message").GetString() == resumed)) break;
                await Task.Delay(100, timeout.Token);
            }
            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, other), timeout.Token))
            {
                Assert.Equal(target.Id, selected.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }
            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                Assert.Equal(histories[1], snapshot.RootElement.GetProperty("status").GetProperty("historyDirectory").GetString());
                Assert.Contains(snapshot.RootElement.GetProperty("entries").EnumerateArray(),
                    entry => entry.GetRawText() == otherEntry.GetRawText());
                Assert.DoesNotContain(snapshot.RootElement.GetProperty("entries").EnumerateArray(),
                    entry => entry.GetProperty("category").GetString() == "ListenAll.SwitchTests");
            }
            await CaptureDemoMessageAsync(client, url, target, target.Id, timeout.Token, includeRelated: false);

            await target.StandardInput.WriteLineAsync("quit");
            target.StandardInput.Close();
            await target.WaitForExitAsync().WaitAsync(ProcessTimeout);
            while (true)
            {
                using JsonDocument state = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), timeout.Token));
                if (state.RootElement.GetProperty("selected").ValueKind == JsonValueKind.Null)
                {
                    Assert.DoesNotContain(state.RootElement.GetProperty("applications").EnumerateArray(),
                        application => application.GetProperty("processId").GetInt32() == target.Id);
                    break;
                }

                await Task.Delay(100, timeout.Token);
            }

            logger.LogInformation("Do not automatically reconnect to this still-running process.");
            using JsonDocument afterExit = await GetSnapshotAsync(client, url, timeout.Token);
            Assert.DoesNotContain(afterExit.RootElement.GetProperty("entries").EnumerateArray(),
                entry => entry.GetProperty("category").GetString() == "ListenAll.SwitchTests");
        }
        finally
        {
            await KillAsync(listener);
            await KillAsync(target);
            await output;
            await targetOutput;
            if (error is not null) await error;
            if (targetError is not null) await targetError;
        }
    }

    [Fact]
    public async Task ListenAllGroupsMatchingPathsAndFollowsMembersWithoutReconnectingAfterTheGroupExits()
    {
        using Process first = StartProcess(new[] { DemoPath, "--showcase" });
        using Process listener = StartProcess(WrapperArguments("--listen-all"));
        List<Process> targets = [first];
        List<Task<string>> output = [first.StandardOutput.ReadToEndAsync(), listener.StandardOutput.ReadToEndAsync()];
        try
        {
            await ReadUrlAsync(first);
            output.Add(first.StandardError.ReadToEndAsync());
            Uri url = await ReadUrlAsync(listener);
            output.Add(listener.StandardError.ReadToEndAsync());
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(40));
            JsonElement state = await WaitForApplicationsAsync(client, url,
                state => state.GetProperty("applications").EnumerateArray().Any(app => IncludesProcess(app, first.Id)), timeout.Token);
            JsonElement application = Assert.Single(state.GetProperty("applications").EnumerateArray(), app => IncludesProcess(app, first.Id));
            Assert.Equal("LogStudio.Demo", application.GetProperty("name").GetString());
            Assert.Equal(DemoPath, application.GetProperty("path").GetString());
            string groupId = application.GetProperty("groupId").GetString()!;
            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, application, includeRelated: true), timeout.Token))
            {
                Assert.True(IncludesProcess(selected.RootElement.GetProperty("selected"), first.Id));
            }
            JsonElement originalEntry = await CaptureDemoMessageAsync(client, url, first, first.Id, timeout.Token);

            Process second = StartProcess(new[] { DemoPath, "--showcase" });
            targets.Add(second);
            output.Add(second.StandardOutput.ReadToEndAsync());
            await ReadUrlAsync(second);
            output.Add(second.StandardError.ReadToEndAsync());
            state = await WaitForApplicationsAsync(client, url,
                state => IncludesProcess(state.GetProperty("selected"), first.Id) && IncludesProcess(state.GetProperty("selected"), second.Id), timeout.Token);
            Assert.Equal(groupId, state.GetProperty("selected").GetProperty("groupId").GetString());
            JsonElement grouped = Assert.Single(state.GetProperty("applications").EnumerateArray(), app => IncludesProcess(app, first.Id));
            Assert.True(IncludesProcess(grouped, second.Id));
            Assert.Equal(2, grouped.GetProperty("processes").GetArrayLength());
            await CaptureDemoMessageAsync(client, url, second, second.Id, timeout.Token);
            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                Assert.Contains(snapshot.RootElement.GetProperty("entries").EnumerateArray(),
                    entry => entry.GetProperty("id").GetInt64() == originalEntry.GetProperty("id").GetInt64() &&
                        entry.GetProperty("message").GetString() == originalEntry.GetProperty("message").GetString());
            }

            await first.StandardInput.WriteLineAsync("quit");
            first.StandardInput.Close();
            await first.WaitForExitAsync().WaitAsync(ProcessTimeout);
            state = await WaitForApplicationsAsync(client, url, state =>
                IncludesProcess(state.GetProperty("selected"), second.Id) && !IncludesProcess(state.GetProperty("selected"), first.Id), timeout.Token);
            Assert.Equal(groupId, state.GetProperty("selected").GetProperty("groupId").GetString());
            await CaptureDemoMessageAsync(client, url, second, second.Id, timeout.Token);
            JsonElement remaining = Assert.Single(state.GetProperty("selected").GetProperty("processes").EnumerateArray(),
                process => process.GetProperty("processId").GetInt32() == second.Id);
            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, remaining), timeout.Token))
            {
                Assert.Equal(second.Id, selected.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }
            using (JsonDocument processHistory = await GetSnapshotAsync(client, url, timeout.Token))
                Assert.Empty(processHistory.RootElement.GetProperty("entries").EnumerateArray());
            await CaptureDemoMessageAsync(client, url, second, second.Id, timeout.Token, includeRelated: false);
            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, remaining, includeRelated: true), timeout.Token))
            {
                Assert.Equal(groupId, selected.RootElement.GetProperty("selected").GetProperty("groupId").GetString());
            }
            using (JsonDocument groupedHistory = await GetSnapshotAsync(client, url, timeout.Token))
            {
                Assert.Contains(groupedHistory.RootElement.GetProperty("entries").EnumerateArray(),
                    entry => entry.GetRawText() == originalEntry.GetRawText());
                Assert.All(groupedHistory.RootElement.GetProperty("entries").EnumerateArray(),
                    entry => Assert.StartsWith("[PID ", entry.GetProperty("message").GetString(), StringComparison.Ordinal));
            }
            await CaptureDemoMessageAsync(client, url, second, second.Id, timeout.Token);
            await second.StandardInput.WriteLineAsync("quit");
            second.StandardInput.Close();
            await second.WaitForExitAsync().WaitAsync(ProcessTimeout);
            await WaitForApplicationsAsync(client, url, state => state.GetProperty("selected").ValueKind == JsonValueKind.Null, timeout.Token);

            Process later = StartProcess(new[] { DemoPath, "--showcase" });
            targets.Add(later);
            output.Add(later.StandardOutput.ReadToEndAsync());
            await ReadUrlAsync(later);
            output.Add(later.StandardError.ReadToEndAsync());
            await WaitForApplicationsAsync(client, url,
                state => state.GetProperty("applications").EnumerateArray().Any(app => IncludesProcess(app, later.Id)), timeout.Token);
            await Task.Delay(TimeSpan.FromSeconds(3), timeout.Token);
            using (JsonDocument afterExit = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), timeout.Token)))
            {
                Assert.Equal(JsonValueKind.Null, afterExit.RootElement.GetProperty("selected").ValueKind);
            }
        }
        finally
        {
            await KillAsync(listener);
            foreach (Process target in targets)
            {
                await KillAsync(target);
                target.Dispose();
            }
            await Task.WhenAll(output);
        }
    }

    [Fact]
    public async Task ListenAllGroupsDotnetRunWithItsActualAppAndKeepsSeparateLaunchesSeparate()
    {
        string project = Path.GetFullPath("../../../LogStudio.Demo.csproj", Path.GetDirectoryName(DemoPath)!);
        string configuration = new DirectoryInfo(Path.GetDirectoryName(DemoPath)!).Parent!.Name;
        string[] arguments = ["run", "--no-build", "--no-launch-profile", "--project", project, "--configuration", configuration, "--", "--showcase"];
        using Process first = StartProcess(arguments);
        using Process second = StartProcess(arguments);
        using Process listener = StartProcess(WrapperArguments("--listen-all"));
        List<Task<string>> output = [first.StandardOutput.ReadToEndAsync(), second.StandardOutput.ReadToEndAsync(), listener.StandardOutput.ReadToEndAsync()];
        try
        {
            await ReadUrlAsync(first);
            output.Add(first.StandardError.ReadToEndAsync());
            await ReadUrlAsync(second);
            output.Add(second.StandardError.ReadToEndAsync());
            Uri url = await ReadUrlAsync(listener);
            output.Add(listener.StandardError.ReadToEndAsync());
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            JsonElement state = await WaitForApplicationsAsync(client, url, state =>
                state.GetProperty("applications").EnumerateArray().Any(app => app.GetProperty("processId").GetInt32() == first.Id && app.GetProperty("processes").GetArrayLength() >= 2) &&
                state.GetProperty("applications").EnumerateArray().Any(app => app.GetProperty("processId").GetInt32() == second.Id && app.GetProperty("processes").GetArrayLength() >= 2), timeout.Token);
            JsonElement firstApp = Assert.Single(state.GetProperty("applications").EnumerateArray(), app => app.GetProperty("processId").GetInt32() == first.Id);
            JsonElement secondApp = Assert.Single(state.GetProperty("applications").EnumerateArray(), app => app.GetProperty("processId").GetInt32() == second.Id);
            Assert.NotEqual(firstApp.GetProperty("groupId").GetString(), secondApp.GetProperty("groupId").GetString());
            Assert.Equal("LogStudio.Demo", firstApp.GetProperty("name").GetString());
            Assert.Equal(DemoPath, firstApp.GetProperty("path").GetString());
            Assert.Equal(DemoPath, secondApp.GetProperty("path").GetString());
            int childId = Assert.Single(firstApp.GetProperty("processes").EnumerateArray(), process => process.GetProperty("name").GetString() == "LogStudio.Demo")
                .GetProperty("processId").GetInt32();
            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, firstApp, includeRelated: true), timeout.Token))
            {
                Assert.Equal(JsonValueKind.Null, selected.RootElement.GetProperty("error").ValueKind);
                Assert.True(IncludesProcess(selected.RootElement.GetProperty("selected"), first.Id));
                Assert.True(IncludesProcess(selected.RootElement.GetProperty("selected"), childId));
            }
            await second.StandardInput.WriteLineAsync("success");
            await CaptureDemoMessageAsync(client, url, first, childId, timeout.Token);
            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                foreach (JsonElement process in secondApp.GetProperty("processes").EnumerateArray())
                    Assert.DoesNotContain(snapshot.RootElement.GetProperty("entries").EnumerateArray(),
                        entry => entry.GetProperty("message").GetString()!.StartsWith($"[PID {process.GetProperty("processId").GetInt32()}]", StringComparison.Ordinal));
            }

            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, secondApp, includeRelated: true), timeout.Token))
            {
                Assert.Equal(secondApp.GetProperty("groupId").GetString(), selected.RootElement.GetProperty("selected").GetProperty("groupId").GetString());
                Assert.Equal(JsonValueKind.Null, selected.RootElement.GetProperty("error").ValueKind);
            }
            int secondChildId = Assert.Single(secondApp.GetProperty("processes").EnumerateArray(), process => process.GetProperty("name").GetString() == "LogStudio.Demo")
                .GetProperty("processId").GetInt32();
            await first.StandardInput.WriteLineAsync("success");
            await CaptureDemoMessageAsync(client, url, second, secondChildId, timeout.Token);
            using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
            {
                foreach (JsonElement process in firstApp.GetProperty("processes").EnumerateArray())
                    Assert.DoesNotContain(snapshot.RootElement.GetProperty("entries").EnumerateArray(),
                        entry => entry.GetProperty("message").GetString()!.StartsWith($"[PID {process.GetProperty("processId").GetInt32()}]", StringComparison.Ordinal));
            }

            if (!OperatingSystem.IsWindows())
            {
                await InterruptAsync(listener);
                await listener.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Assert.Equal(130, listener.ExitCode);
                Assert.False(first.HasExited);
                Assert.False(second.HasExited);
            }
            await first.StandardInput.WriteLineAsync("quit");
            await second.StandardInput.WriteLineAsync("quit");
            first.StandardInput.Close();
            second.StandardInput.Close();
            await Task.WhenAll(first.WaitForExitAsync(), second.WaitForExitAsync()).WaitAsync(ProcessTimeout);
            Assert.Equal(0, first.ExitCode);
            Assert.Equal(0, second.ExitCode);
        }
        finally
        {
            await KillAsync(listener);
            await KillAsync(first);
            await KillAsync(second);
            await Task.WhenAll(output);
        }
    }

    [Fact]
    public async Task ListenAllShutdownIsBoundedWhenTheSelectedTargetCannotAnswerDiagnostics()
    {
        if (OperatingSystem.IsWindows()) return;
        using Process target = StartProcess(new[] { DemoPath, "--showcase" });
        using Process listener = StartProcess(WrapperArguments("--listen-all"));
        Task<string> output = listener.StandardOutput.ReadToEndAsync();
        Task<string>? error = null;
        Task<string> targetOutput = target.StandardOutput.ReadToEndAsync();
        Task<string>? targetError = null;
        try
        {
            await ReadUrlAsync(target);
            targetError = target.StandardError.ReadToEndAsync();
            Uri url = await ReadUrlAsync(listener);
            error = listener.StandardError.ReadToEndAsync();
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            using JsonDocument applications = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), timeout.Token));
            JsonElement application = Assert.Single(applications.RootElement.GetProperty("applications").EnumerateArray(),
                item => item.GetProperty("processId").GetInt32() == target.Id);
            await SignalAsync(target, "STOP");
            using (HttpRequestMessage unresponsiveSelection = new(HttpMethod.Post, ApplicationSelection(url, application)))
            {
                unresponsiveSelection.Headers.Add(ViewerConstants.ClearRequestHeader, "select-application");
                using HttpResponseMessage failed = await client.SendAsync(unresponsiveSelection, timeout.Token);
                Assert.Equal(HttpStatusCode.Conflict, failed.StatusCode);
            }

            using (JsonDocument failedState = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), timeout.Token)))
            {
                Assert.Equal(JsonValueKind.Null, failedState.RootElement.GetProperty("selected").ValueKind);
                Assert.False(string.IsNullOrWhiteSpace(failedState.RootElement.GetProperty("error").GetString()));
            }

            await SignalAsync(target, "CONT");
            using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, application), timeout.Token))
            {
                Assert.Equal(target.Id, selected.RootElement.GetProperty("selected").GetProperty("processId").GetInt32());
            }

            await SignalAsync(target, "STOP");
            await InterruptAsync(listener);
            await listener.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(130, listener.ExitCode);
            Assert.False(target.HasExited);
            await SignalAsync(target, "CONT");
            await target.StandardInput.WriteLineAsync("quit");
            target.StandardInput.Close();
            await target.WaitForExitAsync().WaitAsync(ProcessTimeout);
            Assert.Equal(0, target.ExitCode);
        }
        finally
        {
            if (!target.HasExited) await SignalAsync(target, "CONT");
            await KillAsync(listener);
            await KillAsync(target);
            await output;
            await targetOutput;
            if (error is not null) await error;
            if (targetError is not null) await targetError;
        }
    }

    [Fact]
    public async Task ListenAllUsesSafeManagedEntrypointNamesAndCapsSessionNamesBeforeSelection()
    {
        string directory = Directory.CreateTempSubdirectory("logstudio-listen-target-").FullName;
        try
        {
            foreach (string file in Directory.EnumerateFiles(Path.GetDirectoryName(DemoPath)!, "*.dll"))
            {
                File.Copy(file, Path.Combine(directory, Path.GetFileName(file)));
            }

            string longName = new('n', 160);
            string entrypoint = Path.Combine(directory, longName + ".dll");
            File.Copy(DemoPath, entrypoint);
            using Process target = StartProcess(new[]
            {
                "exec", "--runtimeconfig", Path.ChangeExtension(DemoPath, "runtimeconfig.json"),
                "--depsfile", Path.ChangeExtension(DemoPath, "deps.json"), entrypoint, "--showcase",
            });
            using Process listener = StartProcess(WrapperArguments("--listen-all"));
            Task<string> output = listener.StandardOutput.ReadToEndAsync();
            Task<string>? error = null;
            Task<string> targetOutput = target.StandardOutput.ReadToEndAsync();
            Task<string>? targetError = null;
            try
            {
                await ReadUrlAsync(target);
                targetError = target.StandardError.ReadToEndAsync();
                Uri url = await ReadUrlAsync(listener);
                error = listener.StandardError.ReadToEndAsync();
                using HttpClient client = new();
                using CancellationTokenSource timeout = new(ProcessTimeout);
                using JsonDocument applications = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), timeout.Token));
                JsonElement application = Assert.Single(applications.RootElement.GetProperty("applications").EnumerateArray(),
                    item => item.GetProperty("processId").GetInt32() == target.Id);
                Assert.Equal(longName[..128], application.GetProperty("name").GetString());
                using (JsonDocument selected = await SelectApplicationAsync(client, ApplicationSelection(url, application), timeout.Token))
                {
                    Assert.Equal(JsonValueKind.Null, selected.RootElement.GetProperty("error").ValueKind);
                    Assert.Equal(longName[..128], selected.RootElement.GetProperty("selected").GetProperty("name").GetString());
                }

                using (JsonDocument snapshot = await GetSnapshotAsync(client, url, timeout.Token))
                {
                    Assert.Equal(longName[..128], snapshot.RootElement.GetProperty("status").GetProperty("applicationName").GetString());
                }

                if (!OperatingSystem.IsWindows())
                {
                    await InterruptAsync(listener);
                    await listener.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                    Assert.Equal(130, listener.ExitCode);
                }
                Assert.False(target.HasExited);
                await target.StandardInput.WriteLineAsync("quit");
                target.StandardInput.Close();
                await target.WaitForExitAsync().WaitAsync(ProcessTimeout);
                Assert.Equal(0, target.ExitCode);
            }
            finally
            {
                await KillAsync(listener);
                await KillAsync(target);
                await output;
                await targetOutput;
                if (error is not null) await error;
                if (targetError is not null) await targetError;
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task AChildThatCannotStartProducesAFailureExitCode()
    {
        ProcessResult result = await RunProcessAsync(WrapperArguments("--no-wait", "--", "log-studio-no-such-command-93b6"));
        Assert.Equal(1, result.ExitCode);
        Assert.Contains("Could not launch", result.Error, StringComparison.Ordinal);
        Assert.Contains("Shell aliases and functions", result.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task WrapperKeepsFinishedSkillRunnerLogsAvailable()
    {
        using Process process = StartProcess(WrapperArguments("--", DotnetCommand, DemoPath, "--count", "0", "--exit-code", "7"));
        try
        {
            Uri url = await ReadUrlAsync(process);
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            JsonElement status;
            do
            {
                using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, ViewerConstants.SnapshotRoute), timeout.Token));
                status = snapshot.RootElement.GetProperty("status").Clone();
                if (status.GetProperty("isCompleted").GetBoolean()) break;
                await Task.Delay(20, timeout.Token);
            }
            while (true);
            Assert.False(process.HasExited);
            Assert.Equal(7, status.GetProperty("exitCode").GetInt32());
            Assert.True(status.GetProperty("retainedCount").GetInt32() > 0);
            string name = status.GetProperty("applicationName").GetString()!;
            SessionNameGeneratorTests.AssertFriendlyName(name);
        }
        finally
        {
            await KillAsync(process);
        }
    }

    [Theory]
    [InlineData("My investigation")]
    [InlineData("session-custom-name")]
    public async Task WrapperPreservesExplicitSessionNames(string name)
    {
        using Process process = StartProcess(WrapperArguments("--name", name, "--", DotnetCommand, DemoPath, "--count", "0"));
        try
        {
            Uri url = await ReadUrlAsync(process);
            using HttpClient client = new();
            using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, ViewerConstants.SnapshotRoute)));
            Assert.Equal(name, snapshot.RootElement.GetProperty("status").GetProperty("applicationName").GetString());
        }
        finally
        {
            await KillAsync(process);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    [InlineData(512)]
    public async Task WrapperRetainsFullLongRunUnlessCapacityIsExplicitlyBounded(int? capacity)
    {
        List<string> arguments = new();
        if (capacity.HasValue)
        {
            arguments.Add("--capacity");
            arguments.Add(capacity.Value.ToString(CultureInfo.InvariantCulture));
        }

        arguments.AddRange(new[]
        {
            "--", DotnetCommand, DemoPath,
            "--count", LongRunStepCount.ToString(CultureInfo.InvariantCulture), "--delay", "0",
        });
        using Process process = StartProcess(WrapperArguments(arguments.ToArray()));
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string>? error = null;
        try
        {
            Uri url = await ReadUrlAsync(process);
            error = process.StandardError.ReadToEndAsync();
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            while (true)
            {
                using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, ViewerConstants.SnapshotRoute), timeout.Token));
                JsonElement status = snapshot.RootElement.GetProperty("status");
                if (!status.GetProperty("isCompleted").GetBoolean())
                {
                    await Task.Delay(20, timeout.Token);
                    continue;
                }

                JsonElement entries = snapshot.RootElement.GetProperty("entries");
                long lastId = status.GetProperty("lastId").GetInt64();
                int retainedCount = status.GetProperty("retainedCount").GetInt32();
                Assert.True(lastId > 10_000);
                Assert.Equal(capacity ?? 0, status.GetProperty("capacity").GetInt32());
                Assert.Equal(retainedCount, entries.GetArrayLength());
                if (capacity.GetValueOrDefault() == 0)
                {
                    Assert.Equal(lastId, retainedCount);
                    Assert.Equal(0, status.GetProperty("evictedCount").GetInt64());
                    Assert.Equal(1, status.GetProperty("firstId").GetInt64());
                    Assert.Contains(entries.EnumerateArray(), entry =>
                        entry.GetProperty("message").GetString()?.StartsWith("Search seed:", StringComparison.Ordinal) == true);
                    Assert.Contains(entries.EnumerateArray(), entry =>
                        entry.GetProperty("message").GetString()?.Contains($"Running DemoSkill step {LongRunStepCount};", StringComparison.Ordinal) == true);
                }
                else
                {
                    Assert.Equal(capacity.GetValueOrDefault(), retainedCount);
                    Assert.Equal(lastId - retainedCount, status.GetProperty("evictedCount").GetInt64());
                    Assert.Equal(lastId - retainedCount + 1, status.GetProperty("firstId").GetInt64());
                }

                break;
            }
        }
        finally
        {
            await KillAsync(process);
            await output;
            if (error is not null) await error;
        }
    }

    [Fact]
    public async Task WrapperHelpDescribesUnlimitedRetention()
    {
        ProcessResult result = await RunProcessAsync(WrapperArguments("--help"));
        Assert.Equal(0, result.ExitCode);
        Assert.Contains("0 keeps all entries (default)", result.Output, StringComparison.Ordinal);
        Assert.Contains("stored in private temporary files", result.Output, StringComparison.Ordinal);
        Assert.Contains("--version", result.Output, StringComparison.Ordinal);
        Assert.Contains("default: 5177", result.Output, StringComparison.Ordinal);
        Assert.Contains("Redirected input never prompts", result.Output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("--version")]
    [InlineData("--open", "--version")]
    [InlineData("--version", "--", "log-studio-no-such-command-93b6")]
    public async Task WrapperVersionPrintsInstalledVersionWithoutStartingTheViewer(params string[] args)
    {
        ProcessResult result = await RunProcessAsync(WrapperArguments(args));
        string? productVersion = FileVersionInfo.GetVersionInfo(ToolPath).ProductVersion;
        Assert.False(string.IsNullOrWhiteSpace(productVersion));
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(productVersion.Split('+')[0] + Environment.NewLine, result.Output);
        Assert.Empty(result.Error);
    }

    [Fact]
    public async Task WrapperPassesVersionArgumentAfterSeparatorToTheChild()
    {
        ProcessResult expected = await RunProcessAsync(new[] { "--version" });
        ProcessResult result = await RunProcessAsync(WrapperArguments("--no-wait", "--", DotnetCommand, "--version"));
        Assert.Equal(0, expected.ExitCode);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(expected.Output, result.Output);
        Assert.Contains(UrlPrefix, result.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task StartupHookCapturesAnUnmodifiedDotnetHost()
    {
        string hookDirectory = Directory.CreateTempSubdirectory("logstudio-hook-test-").FullName;
        string hookPath = Path.Combine(hookDirectory, "LogStudio.dll");
        File.Copy(typeof(ConsoleLogViewer).Assembly.Location, hookPath);
        using Process process = StartProcess(
            new[] { DemoPath, "--count", "0", "--interactive", "--exit-code", "7" },
            new Dictionary<string, string>
            {
                [StartupHooksEnvironmentVariable] = hookPath,
                [ViewerConstants.EnabledEnvironmentVariable] = "true",
                [ViewerConstants.CapacityEnvironmentVariable] = "0",
            });
        try
        {
            Uri url = await ReadUrlAsync(process);
            using HttpClient client = new();
            using CancellationTokenSource timeout = new(ProcessTimeout);
            bool captured;
            do
            {
                using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, ViewerConstants.SnapshotRoute), timeout.Token));
                SessionNameGeneratorTests.AssertFriendlyName(snapshot.RootElement.GetProperty("status").GetProperty("applicationName").GetString()!);
                captured = snapshot.RootElement.GetProperty("entries").EnumerateArray()
                    .Any(entry => entry.GetProperty("message").GetString()?.Contains("Search seed", StringComparison.Ordinal) == true);
                if (!captured) await Task.Delay(20, timeout.Token);
            }
            while (!captured);
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> error = process.StandardError.ReadToEndAsync();
            await process.StandardInput.WriteLineAsync(Payload);
            process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(ProcessTimeout);
            Assert.Equal(7, process.ExitCode);
            Assert.Contains(Payload, await output, StringComparison.Ordinal);
            await error;
        }
        finally
        {
            await KillAsync(process);
            Directory.Delete(hookDirectory, true);
        }
    }

    [Fact]
    public async Task StartupHookDoesNotAttachToDotnetBuildDriver()
    {
        ProcessResult result = await RunProcessAsync(
            new[] { "--version" },
            new Dictionary<string, string> { [StartupHooksEnvironmentVariable] = typeof(ConsoleLogViewer).Assembly.Location });
        Assert.Equal(0, result.ExitCode);
        Assert.DoesNotContain(UrlPrefix, result.Error, StringComparison.Ordinal);
    }

    private static string DemoPath => FixturePath(DemoMetadataKey);

    private static string ToolPath => FixturePath(ToolMetadataKey);

    private static string FixturePath(string key) => typeof(ProcessTests).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .Single(attribute => attribute.Key == key).Value ?? throw new InvalidOperationException($"Missing fixture metadata: {key}.");

    private static string[] WrapperArguments(params string[] arguments) => new[] { ToolPath, "--port", "0" }.Concat(arguments).ToArray();

    private static Uri ApplicationSelection(Uri url, JsonElement application, bool includeRelated = false) => new(url,
        $"api/applications?processId={application.GetProperty("processId").GetInt32()}&startedAtTicks={application.GetProperty("startedAtTicks").GetString()}" +
        (includeRelated ? "&scope=application" : ""));

    private static bool IncludesProcess(JsonElement application, int processId) =>
        application.ValueKind == JsonValueKind.Object && application.GetProperty("processes").EnumerateArray()
            .Any(process => process.GetProperty("processId").GetInt32() == processId);

    private static async Task<JsonElement> WaitForApplicationsAsync(HttpClient client, Uri url,
        Func<JsonElement, bool> predicate, CancellationToken cancellationToken)
    {
        while (true)
        {
            using JsonDocument state = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/applications"), cancellationToken));
            if (predicate(state.RootElement)) return state.RootElement.Clone();
            await Task.Delay(100, cancellationToken);
        }
    }

    private static async Task<JsonElement> CaptureDemoMessageAsync(HttpClient client, Uri url, Process input,
        int processId, CancellationToken cancellationToken, bool includeRelated = true)
    {
        using JsonDocument before = await GetSnapshotAsync(client, url, cancellationToken);
        long lastId = before.RootElement.GetProperty("status").GetProperty("lastId").GetInt64();
        while (true)
        {
            await input.StandardInput.WriteLineAsync("success");
            using JsonDocument snapshot = await GetSnapshotAsync(client, url, cancellationToken);
            JsonElement match = snapshot.RootElement.GetProperty("entries").EnumerateArray().FirstOrDefault(entry =>
                entry.GetProperty("id").GetInt64() > lastId &&
                entry.GetProperty("message").GetString()!.StartsWith(includeRelated ? $"[PID {processId}] Checkout " : "Checkout ", StringComparison.Ordinal));
            if (match.ValueKind != JsonValueKind.Undefined) return match.Clone();
            await Task.Delay(250, cancellationToken);
        }
    }

    private static async Task<JsonDocument> SelectApplicationAsync(HttpClient client, Uri route, CancellationToken cancellationToken)
    {
        using HttpRequestMessage selection = new(HttpMethod.Post, route);
        selection.Headers.Add(ViewerConstants.ClearRequestHeader, "select-application");
        using HttpResponseMessage response = await client.SendAsync(selection, cancellationToken);
        response.EnsureSuccessStatusCode();
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
    }

    private static async Task<JsonDocument> GetSnapshotAsync(HttpClient client, Uri url, CancellationToken cancellationToken)
    {
        JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, ViewerConstants.SnapshotRoute), cancellationToken));
        if (ViewerProcesses.TryGetValue(url, out int processId))
            HistoryDirectories.GetOrAdd(processId, _ => new())[snapshot.RootElement.GetProperty("status").GetProperty("historyDirectory").GetString()!] = 0;
        return snapshot;
    }

    private static Task InterruptAsync(Process process) => SignalAsync(process, "INT");

    private static async Task SignalAsync(Process process, string name)
    {
        ProcessStartInfo info = new("kill") { UseShellExecute = false };
        info.ArgumentList.Add("-s");
        info.ArgumentList.Add(name);
        info.ArgumentList.Add(process.Id.ToString(CultureInfo.InvariantCulture));
        using Process signal = Process.Start(info)!;
        await signal.WaitForExitAsync().WaitAsync(ProcessTimeout);
        Assert.Equal(0, signal.ExitCode);
    }

    private static Process StartProcess(
        IEnumerable<string> arguments,
        IReadOnlyDictionary<string, string>? environment = null,
        string? workingDirectory = null)
    {
        ProcessStartInfo info = new(DotnetCommand)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
        };
        if (workingDirectory is not null) info.WorkingDirectory = workingDirectory;
        info.Environment.Remove(StartupHooksEnvironmentVariable);
        info.Environment[ViewerConstants.SessionsDirectoryEnvironmentVariable] = ProcessArchivesFixture.Root;
        foreach (string argument in arguments) info.ArgumentList.Add(argument);
        if (environment is not null)
        {
            foreach (KeyValuePair<string, string> item in environment) info.Environment[item.Key] = item.Value;
        }

        Process process = new() { StartInfo = info };
        if (!process.Start()) throw new InvalidOperationException("The test child failed to start.");
        return process;
    }

    private static async Task<ProcessResult> RunProcessAsync(
        IEnumerable<string> arguments,
        IReadOnlyDictionary<string, string>? environment = null,
        string? input = null,
        string? workingDirectory = null)
    {
        using Process process = StartProcess(arguments, environment, workingDirectory);
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        Task<string> error = process.StandardError.ReadToEndAsync();
        try
        {
            if (input is not null) await process.StandardInput.WriteLineAsync(input);
            process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(ProcessTimeout);
            return new ProcessResult(process.ExitCode, await output, await error);
        }
        finally
        {
            await KillAsync(process);
        }
    }

    private static async Task<Uri> ReadUrlAsync(Process process)
    {
        using CancellationTokenSource timeout = new(ProcessTimeout);
        while (true)
        {
            string? line = await process.StandardError.ReadLineAsync(timeout.Token);
            if (line is null) throw new InvalidOperationException("The process exited without announcing a viewer URL.");
            if (line.StartsWith(UrlPrefix, StringComparison.Ordinal))
            {
                Uri url = new(line[UrlPrefix.Length..]);
                using HttpClient client = new();
                using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, ViewerConstants.SearchRoute), timeout.Token));
                string directory = page.RootElement.GetProperty("status").GetProperty("historyDirectory").GetString() ??
                    throw new InvalidOperationException("The viewer did not return its temporary history directory.");
                HistoryDirectories.GetOrAdd(process.Id, _ => new())[directory] = 0;
                ViewerProcesses[url] = process.Id;
                return url;
            }
        }
    }

    private static async Task KillAsync(Process process)
    {
        if (!process.HasExited)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException) when (process.HasExited)
            {
            }
        }

        await process.WaitForExitAsync().WaitAsync(ProcessTimeout);
        foreach (Uri url in ViewerProcesses.Where(pair => pair.Value == process.Id).Select(pair => pair.Key))
            ViewerProcesses.TryRemove(url, out _);
        if (HistoryDirectories.TryRemove(process.Id, out ConcurrentDictionary<string, byte>? directories))
        {
            foreach (string directory in directories.Keys.Where(Directory.Exists))
            {
                foreach (string file in HistoryFileNames) File.Delete(Path.Combine(directory, file));
                Directory.Delete(directory);
            }
        }
    }

    private sealed record ProcessResult(int ExitCode, string Output, string Error);
}
