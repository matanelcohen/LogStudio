using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace LogStudio.Demo;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        DemoOptions options;
        try
        {
            options = DemoOptions.Parse(args);
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine(exception.Message);
            return 2;
        }

        using ConsoleLogViewer? viewer = options.Showcase
            ? ConsoleLogViewer.Start(new ConsoleLogViewerOptions
            {
                ApplicationName = "Logs showcase",
                CaptureTelemetry = true,
                MeterSources = "LogStudio.Demo.*",
                ActivitySources = "LogStudio.Demo.*",
                TelemetryIntervalMilliseconds = 250,
            })
            : null;
        using IHost host = Host.CreateDefaultBuilder(Array.Empty<string>())
            .ConfigureLogging(logging =>
            {
                logging.ClearProviders();
                logging.SetMinimumLevel(LogLevel.Trace);
                logging.AddSimpleConsole(console =>
                {
                    console.TimestampFormat = DemoOptions.TimestampFormat;
                    console.IncludeScopes = true;
                });
            })
            .ConfigureServices(services =>
            {
                services.AddSingleton(options);
                services.AddHostedService<DemoRunner>();
            })
            .Build();
        await host.RunAsync().ConfigureAwait(false);
        return options.ExitCode;
    }
}

internal sealed record DemoOptions(int Count, int Delay, int ExitCode, bool Interactive, bool Showcase)
{
    internal const string TimestampFormat = "HH:mm:ss.fff ";
    internal const string CountSwitch = "--count";
    internal const string DelaySwitch = "--delay";
    internal const string ExitCodeSwitch = "--exit-code";
    internal const string InteractiveSwitch = "--interactive";
    internal const string ShowcaseSwitch = "--showcase";

    internal static DemoOptions Parse(string[] args)
    {
        int count = 120;
        int delay = 150;
        int exitCode = 0;
        bool interactive = false;
        bool showcase = false;
        for (int index = 0; index < args.Length; index++)
        {
            string option = args[index];
            if (option == InteractiveSwitch)
            {
                interactive = true;
                continue;
            }
            if (option == ShowcaseSwitch)
            {
                showcase = true;
                continue;
            }

            if (option is not (CountSwitch or DelaySwitch or ExitCodeSwitch) ||
                ++index >= args.Length ||
                !int.TryParse(args[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out int value))
            {
                throw new ArgumentException($"Invalid demo option '{option}'. Use --count, --delay, --exit-code, --interactive, or --showcase.");
            }

            switch (option)
            {
                case CountSwitch:
                    count = value;
                    break;
                case DelaySwitch:
                    delay = value;
                    break;
                case ExitCodeSwitch:
                    exitCode = value;
                    break;
            }
        }

        if (count < 0 || delay < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(args), "Count and delay must be non-negative.");
        }

        return new DemoOptions(count, delay, exitCode, interactive, showcase);
    }
}

internal sealed class DemoRunner : BackgroundService
{
    private const string EvaluationId = "demo-evaluation-001";
    private const string ScopeFormat = "EvaluationId:{EvaluationId}";
    private const string InputPrompt = "Input> ";
    private const string ReceivedFormat = "Received: {0}";
    private const string SeedMarkup = "<script>globalThis.viewerInjected = true</script> literal output, not HTML";
    private const string SeedSearch = "Search seed: alpha beta; skill=DemoSkill; session=demo-session-001";
    private const string SeedWarning = "Synthetic retry warning for demo search";
    private const string SeedError = "Synthetic failure for viewer demonstration.";
    private readonly ILogger<DemoRunner> logger;
    private readonly IHostApplicationLifetime lifetime;
    private readonly DemoOptions options;

    public DemoRunner(ILogger<DemoRunner> logger, IHostApplicationLifetime lifetime, DemoOptions options)
    {
        this.logger = logger;
        this.lifetime = lifetime;
        this.options = options;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            Console.WriteLine(SeedSearch);
            Console.WriteLine(SeedMarkup);
            Console.WriteLine("\u001b[32mANSI-colored console output\u001b[0m");
            Console.Error.WriteLine("Error: synthetic stderr entry");
            using IDisposable? scope = this.logger.BeginScope(ScopeFormat, EvaluationId);
            this.logger.LogWarning(SeedWarning);
            this.logger.LogError(new InvalidOperationException(SeedError), "Evaluation {EvaluationId} reported a synthetic error", EvaluationId);

            if (this.options.Showcase)
            {
                await this.RunShowcaseAsync(stoppingToken).ConfigureAwait(false);
                return;
            }

            for (int index = 1; index <= this.options.Count; index++)
            {
                this.logger.LogInformation("Running DemoSkill step {Step}; EvaluationId={EvaluationId}", index, EvaluationId);
                if (index % 10 == 0)
                {
                    this.logger.LogWarning("Retrying demo request at step {Step}", index);
                }

                if (index % 25 == 0)
                {
                    this.logger.LogDebug("Checkpoint reached at step {Step}", index);
                }

                if (this.options.Delay > 0)
                {
                    await Task.Delay(this.options.Delay, stoppingToken).ConfigureAwait(false);
                }

            }

            if (this.options.Interactive)
            {
                Console.Write(InputPrompt);
                string? input = await Console.In.ReadLineAsync(stoppingToken).ConfigureAwait(false);
                Console.WriteLine(ReceivedFormat, input);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            this.lifetime.StopApplication();
        }
    }

    private async Task RunShowcaseAsync(CancellationToken stoppingToken)
    {
        using DemoTelemetry telemetry = new();
        int orderId = 0;
        foreach (string scenario in new[] { "success", "slow", "error" })
        {
            await this.RunOrderAsync(telemetry, ++orderId, scenario, stoppingToken).ConfigureAwait(false);
        }

        Console.WriteLine("Synthetic demo data only. Open the printed Log Studio URL to explore logs in Discover.");
        Console.WriteLine("Commands: success, slow, error, burst (10 mixed orders), help, quit. Ctrl+C also stops the demo.");
        while (!stoppingToken.IsCancellationRequested)
        {
            Console.Write("Demo> ");
            string? input = await Task.Run(() => Console.In.ReadLine(), stoppingToken).WaitAsync(stoppingToken).ConfigureAwait(false);
            string? command = input?.Trim().ToLowerInvariant();
            if (command is null or "quit" or "exit") break;
            if (command is "success" or "slow" or "error")
            {
                await this.RunOrderAsync(telemetry, ++orderId, command, stoppingToken).ConfigureAwait(false);
            }
            else if (command == "burst")
            {
                for (int index = 0; index < 10; index++)
                {
                    string scenario = index % 5 == 4 ? "error" : index % 3 == 2 ? "slow" : "success";
                    await this.RunOrderAsync(telemetry, ++orderId, scenario, stoppingToken).ConfigureAwait(false);
                }
            }
            else
            {
                Console.WriteLine("Commands: success, slow, error, burst, help, quit.");
            }
        }
    }

    private async Task RunOrderAsync(DemoTelemetry telemetry, int orderId, string scenario, CancellationToken stoppingToken)
    {
        using Activity? order = telemetry.Orders.StartActivity("checkout", ActivityKind.Server);
        order?.SetTag("order.id", orderId);
        order?.SetTag("demo.scenario", scenario);
        using IDisposable? scope = this.logger.BeginScope("OrderId:{OrderId} TraceId:{TraceId}", orderId, order?.TraceId.ToString());
        Stopwatch duration = Stopwatch.StartNew();
        telemetry.InFlight.Add(1);
        try
        {
            this.logger.LogInformation("Checkout {OrderId} started; scenario={Scenario}", orderId, scenario);
            using (Activity? inventory = telemetry.Inventory.StartActivity("reserve-stock", ActivityKind.Internal))
            {
                inventory?.SetTag("product.id", "demo-widget");
                this.logger.LogDebug("Reserving synthetic inventory for order {OrderId}", orderId);
                await Task.Delay(30, stoppingToken).ConfigureAwait(false);
                inventory?.SetStatus(ActivityStatusCode.Ok);
            }

            using (Activity? payment = telemetry.Payments.StartActivity("charge-payment", ActivityKind.Client))
            {
                payment?.SetTag("payment.provider", "synthetic");
                if (scenario == "slow")
                {
                    this.logger.LogWarning("Synthetic slow payment for order {OrderId}", orderId);
                    payment?.AddEvent(new ActivityEvent("simulated-delay"));
                }

                await Task.Delay(scenario == "slow" ? 600 : 60, stoppingToken).ConfigureAwait(false);
                if (scenario == "error")
                {
                    payment?.SetStatus(ActivityStatusCode.Error, "Synthetic payment declined");
                    payment?.SetTag("error.type", "DemoPaymentDeclined");
                    order?.SetStatus(ActivityStatusCode.Error, "Synthetic checkout failure");
                    this.logger.LogError(new InvalidOperationException("Synthetic payment declined; no real payment was attempted."),
                        "Checkout {OrderId} failed; TraceId={TraceId}", orderId, order?.TraceId.ToString());
                }
                else
                {
                    payment?.SetStatus(ActivityStatusCode.Ok);
                    order?.SetStatus(ActivityStatusCode.Ok);
                    this.logger.LogInformation("Checkout {OrderId} completed; TraceId={TraceId}", orderId, order?.TraceId.ToString());
                }
            }

            telemetry.Requests.Add(1, new KeyValuePair<string, object?>("scenario", scenario));
            telemetry.Duration.Record(duration.Elapsed.TotalMilliseconds, new KeyValuePair<string, object?>("scenario", scenario));
            if (scenario == "error") telemetry.Errors.Add(1);
            telemetry.CompleteOrder();
        }
        finally
        {
            telemetry.InFlight.Add(-1);
        }
    }
}
