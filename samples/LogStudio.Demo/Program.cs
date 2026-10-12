using System;
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

internal sealed record DemoOptions(int Count, int Delay, int ExitCode, bool Interactive)
{
    internal const string TimestampFormat = "HH:mm:ss.fff ";
    internal const string CountSwitch = "--count";
    internal const string DelaySwitch = "--delay";
    internal const string ExitCodeSwitch = "--exit-code";
    internal const string InteractiveSwitch = "--interactive";

    internal static DemoOptions Parse(string[] args)
    {
        int count = 120;
        int delay = 150;
        int exitCode = 0;
        bool interactive = false;
        for (int index = 0; index < args.Length; index++)
        {
            string option = args[index];
            if (option == InteractiveSwitch)
            {
                interactive = true;
                continue;
            }

            if (option is not (CountSwitch or DelaySwitch or ExitCodeSwitch) ||
                ++index >= args.Length ||
                !int.TryParse(args[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out int value))
            {
                throw new ArgumentException($"Invalid demo option '{option}'. Use --count, --delay, --exit-code, or --interactive.");
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

        return new DemoOptions(count, delay, exitCode, interactive);
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
}
