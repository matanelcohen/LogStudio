using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
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
    private const int LongRunStepCount = 4000;
    private static readonly TimeSpan ProcessTimeout = TimeSpan.FromSeconds(20);
    private static readonly ConcurrentDictionary<int, string> HistoryDirectories = new();
    private static readonly string[] HistoryFileNames = { "entries.jsonl", "entries.idx" };

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
        Assert.Contains($"Input> Received: {Payload}", result.Output, StringComparison.Ordinal);
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
    public async Task InvalidWrapperArgumentsFailExplicitly(params string[] args)
    {
        ProcessResult result = await RunProcessAsync(WrapperArguments(args));
        Assert.Equal(2, result.ExitCode);
        Assert.False(string.IsNullOrWhiteSpace(result.Error));
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

    private static string[] WrapperArguments(params string[] arguments) => new[] { ToolPath }.Concat(arguments).ToArray();

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
                HistoryDirectories[process.Id] = page.RootElement.GetProperty("status").GetProperty("historyDirectory").GetString() ??
                    throw new InvalidOperationException("The viewer did not return its temporary history directory.");
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
        if (HistoryDirectories.TryRemove(process.Id, out string? directory) && Directory.Exists(directory))
        {
            foreach (string file in HistoryFileNames) File.Delete(Path.Combine(directory, file));
            Directory.Delete(directory);
        }
    }

    private sealed record ProcessResult(int ExitCode, string Output, string Error);
}
