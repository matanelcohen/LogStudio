using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Xunit;

namespace LogStudio.Tests;

public sealed class CaptureTests
{
    private const string LoggerCategory = "LogStudio.Tests.ConsoleHost";
    private const string LoggerMessage = "skill-runner-warning";
    private const string SyntheticScope = "EvaluationId:demo-001";
    private const int UnlimitedWriterCount = 8;
    private const int EntriesPerUnlimitedWriter = 15_000;
    private const int CapacityAbovePreviousMaximum = 100_001;

    [Fact]
    public void TeePreservesOriginalOutputAndNormalizesLineEndings()
    {
        using ConsoleLogViewer viewer = StartServer();
        using StringWriter original = new() { NewLine = "\r\n" };
        using TextWriter writer = viewer.CreateCaptureWriter(original, LogStream.Stdout);
        writer.Write("first\r");
        writer.Write("\nsecond\nprogress\rfinal");
        writer.Flush();

        Assert.Equal("first\r\nsecond\nprogress\rfinal", original.ToString());
        Assert.Equal(new[] { "first", "second", "progress", "final" }, viewer.GetLogs().Select(entry => entry.Message));
        Assert.True(viewer.GetLogs()[^1].IsPartial);
    }

    [Fact]
    public async Task PartialPromptsAppearWithoutNewlineAndAreNotDuplicated()
    {
        await using ConsoleLogViewer viewer = StartServer();
        using StringWriter original = new();
        using TextWriter writer = viewer.CreateCaptureWriter(original, LogStream.Stdout);
        writer.Write("Input> ");
        await WaitUntilAsync(() => viewer.GetLogs().Count > 0);
        Assert.Equal("Input> ", Assert.Single(viewer.GetLogs()).Message);
        writer.Write("\nnext\n");
        Assert.Equal(new[] { "Input> ", "next" }, viewer.GetLogs().Select(entry => entry.Message));
        Assert.Equal("Input> \nnext\n", original.ToString());
    }

    [Fact]
    public void LongLinesAreBoundedWithoutDiscardingTextOrBreakingSurrogatePairs()
    {
        using ConsoleLogViewer viewer = StartServer(maxLineLength: 64);
        using StringWriter original = new();
        using TextWriter writer = viewer.CreateCaptureWriter(original, LogStream.Stdout);
        string text = new string('x', 63) + "\U0001F642" + new string('y', 200);
        writer.WriteLine(text);
        Assert.Equal(text, string.Concat(viewer.GetLogs().Select(entry => entry.Message)));
        Assert.All(viewer.GetLogs(), entry =>
        {
            Assert.InRange(entry.Message.Length, 1, 64);
            Assert.False(char.IsHighSurrogate(entry.Message[^1]));
        });
        Assert.Equal(text + Environment.NewLine, original.ToString());
    }

    [Fact]
    public void TerminalColorsAndHyperlinksAreRemovedOnlyFromBrowserText()
    {
        using ConsoleLogViewer viewer = StartServer();
        using StringWriter original = new();
        using TextWriter writer = viewer.CreateCaptureWriter(original, LogStream.Stdout);
        const string text = "\u001b[31mred\u001b[0m \u001b]8;;https://example.invalid\u0007link\u001b]8;;\u001b\\";
        writer.Write(text[..5]);
        writer.WriteLine(text[5..]);
        Assert.Equal("red link", Assert.Single(viewer.GetLogs()).Message);
        Assert.Equal(text + Environment.NewLine, original.ToString());
    }

    [Theory]
    [InlineData("\n")]
    [InlineData("\r\n")]
    [InlineData("\r")]
    public void MultilineErrorsAreOneEntryAcrossWriteAndLineEndingBoundaries(string newline)
    {
        using ConsoleLogViewer viewer = StartServer();
        using StringWriter original = new();
        using TextWriter writer = viewer.CreateCaptureWriter(original, LogStream.Stdout);
        string[] lines =
        {
            "\u001b[31m12:20:33.123 fail: My.Category[42]\u001b[0m",
            "      Request failed",
            "      System.InvalidOperationException: outer failure",
            "       ---> System.ArgumentException: inner failure",
            "         at Example.Run()",
            "         --- End of inner exception stack trace ---",
            "         at Example.Main()",
        };
        string text = string.Join(newline, lines) + newline;
        foreach (char character in text) writer.Write(character);
        writer.Flush();

        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal("12:20:33.123 fail: My.Category[42]\n" + string.Join("\n", lines.Skip(1)), entry.Message);
        Assert.Equal(LogSeverity.Error, entry.Severity);
        Assert.Equal("My.Category", entry.Category);
        Assert.False(entry.IsPartial);
        Assert.Equal(text, original.ToString());
    }

    [Fact]
    public void NewHeadersAndOrdinaryOutputDoNotMergeWithPreviousEntries()
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.Write("[ERR] first\n  details\n[ERR] second\n\tmore details\nordinary output\nanother line\n\n");
        writer.Flush();

        Assert.Equal(new[] { "[ERR] first\n  details", "[ERR] second\n\tmore details", "ordinary output", "another line", "" },
            viewer.GetLogs().Select(entry => entry.Message));
    }

    [Theory]
    [InlineData("trce: My.Category[0]", LogSeverity.Trace, "My.Category")]
    [InlineData("dbug: My.Category[0]", LogSeverity.Debug, "My.Category")]
    [InlineData("info: My.Category[0]", LogSeverity.Information, "My.Category")]
    [InlineData("warn: My.Category[0]", LogSeverity.Warning, "My.Category")]
    [InlineData("fail: My.Category[0]", LogSeverity.Error, "My.Category")]
    [InlineData("crit: My.Category[0]", LogSeverity.Critical, "My.Category")]
    [InlineData("[INF] information", LogSeverity.Information, null)]
    [InlineData("[WRN] warning", LogSeverity.Warning, null)]
    public void MultilineMessagesAreGroupedAtEveryLogLevel(string header, LogSeverity severity, string? category)
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.Write(header + "\n  first detail\n\tsecond detail\n" + header + "\n  next event\n");
        writer.Flush();

        LogEntry[] entries = viewer.GetLogs().ToArray();
        Assert.Equal(new[] { header + "\n  first detail\n\tsecond detail", header + "\n  next event" },
            entries.Select(entry => entry.Message));
        Assert.All(entries, entry =>
        {
            Assert.Equal(severity, entry.Severity);
            Assert.Equal(category, entry.Category);
            Assert.False(entry.IsPartial);
        });
    }

    [Theory]
    [InlineData("Error: connection failed")]
    [InlineData("Fatal error: connection failed")]
    [InlineData("!! connection failed")]
    public void IndentedErrorTextKeepsTheOriginalLogEventMetadata(string message)
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.Write("warn: My.Category[0]\n      " + message + "\n      retrying\n");
        writer.Flush();

        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal("warn: My.Category[0]\n      " + message + "\n      retrying", entry.Message);
        Assert.Equal(LogSeverity.Warning, entry.Severity);
        Assert.Equal("My.Category", entry.Category);
    }

    [Fact]
    public void UnhandledExceptionStartsAnErrorEventAfterAnInformationalLog()
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stderr);
        writer.Write("[INF] ready\nUnhandled exception. System.InvalidOperationException: boom\n   at Example.Run()\n");
        writer.Flush();

        LogEntry[] entries = viewer.GetLogs().ToArray();
        Assert.Equal(new[] { "[INF] ready", "Unhandled exception. System.InvalidOperationException: boom\n   at Example.Run()" },
            entries.Select(entry => entry.Message));
        Assert.Equal(new[] { LogSeverity.Information, LogSeverity.Error }, entries.Select(entry => entry.Severity));
    }

    [Theory]
    [InlineData("System.InvalidOperationException: failure")]
    [InlineData("Unhandled exception. System.InvalidOperationException: failure")]
    public void RawExceptionStacksAndMarkersAreGrouped(string header)
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.WriteLine(header);
        writer.WriteLine("---> System.ArgumentException: inner");
        writer.WriteLine("at Example.Run()");
        writer.WriteLine("--- End of stack trace from previous location ---");
        writer.WriteLine("   at Example.Main()");
        writer.Flush();

        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal(header + "\n---> System.ArgumentException: inner\nat Example.Run()\n" +
            "--- End of stack trace from previous location ---\n   at Example.Main()", entry.Message);
        Assert.Equal(LogSeverity.Error, entry.Severity);
    }

    [Fact]
    public void UnindentedExceptionBelongsToLoggerHeaderButSeparateExceptionsStaySeparate()
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stderr);
        writer.Write("[ERR] request failed\nSystem.Exception: first\n   at Example.First()\n" +
            "System.Exception: second\n   at Example.Second()\n");
        writer.Flush();

        Assert.Equal(new[] { "[ERR] request failed\nSystem.Exception: first\n   at Example.First()",
            "System.Exception: second\n   at Example.Second()" }, viewer.GetLogs().Select(entry => entry.Message));
    }

    [Fact]
    public void MultilineStateIsIsolatedBetweenStreamsAndIndependentWriters()
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter stdout = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        using TextWriter stderr = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stderr);
        using TextWriter other = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        stdout.Write("fail: First.Category[0]\n");
        stderr.Write("crit: Second.Category[0]\n");
        other.Write("warn: Third.Category[0]\n");
        stdout.Write("  first stack\n");
        stderr.Write("  second stack\n");
        other.Write("  third detail\n");
        stdout.Flush();
        stderr.Flush();
        other.Flush();

        LogEntry[] entries = viewer.GetLogs().ToArray();
        Assert.Equal(new[] { "fail: First.Category[0]\n  first stack", "crit: Second.Category[0]\n  second stack",
            "warn: Third.Category[0]\n  third detail" }, entries.Select(entry => entry.Message));
        Assert.Equal(new[] { "First.Category", "Second.Category", "Third.Category" }, entries.Select(entry => entry.Category));
        Assert.Equal(new[] { LogStream.Stdout, LogStream.Stderr, LogStream.Stdout }, entries.Select(entry => entry.Stream));
        Assert.Equal(new[] { LogSeverity.Error, LogSeverity.Critical, LogSeverity.Warning }, entries.Select(entry => entry.Severity));
    }

    [Fact]
    public async Task IdleFlushPublishesFinalMultilineEntryWithoutAnotherHeader()
    {
        await using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.Write("fail: My.Category[0]\n  failure\n   at Example.Run()\n");
        await WaitUntilAsync(() => viewer.GetLogs().Count > 0);

        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal("fail: My.Category[0]\n  failure\n   at Example.Run()", entry.Message);
        Assert.False(entry.IsPartial);
        writer.Flush();
        Assert.Single(viewer.GetLogs());
    }

    [Theory]
    [InlineData("      warning details")]
    [InlineData("      Error: connection failed")]
    [InlineData("      Fatal error: connection failed")]
    [InlineData("      !! connection failed")]
    [InlineData("      System.Exception: connection failed")]
    public async Task ContinuationsAfterIdlePublicationKeepWriterLocalMetadata(string message)
    {
        await using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        using TextWriter other = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.Write("warn: My.Category[0]\n");
        await WaitUntilAsync(() => viewer.GetLogs().Count > 0);
        other.Write("info: Other.Category[0]\n");
        other.Flush();
        writer.Write(message + "\n");
        writer.Flush();

        LogEntry entry = viewer.GetLogs()[^1];
        Assert.Equal(message, entry.Message);
        Assert.Equal(LogSeverity.Warning, entry.Severity);
        Assert.Equal("My.Category", entry.Category);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CompletionAndWriterDisposalFlushMultilineEntries(bool disposeWriter)
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.Write("[ERR] failure\n   at Example.Run()");
        if (disposeWriter) writer.Dispose();
        else viewer.Complete();

        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal("[ERR] failure\n   at Example.Run()", entry.Message);
        Assert.True(entry.IsPartial);
    }

    [Fact]
    public void ClearingHistoryFlushesAndResetsPendingMultilineState()
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.Write("fail: Old.Category[0]\n  remove this stack\n");
        Assert.Equal(1, viewer.ClearLogs());
        writer.Write("info: New.Category[0]\n  keep this message\n");
        writer.Flush();

        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal("info: New.Category[0]\n  keep this message", entry.Message);
        Assert.Equal(LogSeverity.Information, entry.Severity);
        Assert.Equal("New.Category", entry.Category);
    }

    [Fact]
    public void ClearingHistoryResetsWriterLocalContinuationMetadata()
    {
        using ConsoleLogViewer viewer = StartServer();
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        writer.Write("warn: Old.Category[0]\n");
        Assert.Equal(1, viewer.ClearLogs());
        writer.Write("      unrelated new text\n");
        writer.Flush();

        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal(LogSeverity.Output, entry.Severity);
        Assert.Null(entry.Category);
    }

    [Fact]
    public void OversizedMultilineEntriesPreserveTextMetadataAndSurrogatePairs()
    {
        using ConsoleLogViewer viewer = StartServer(maxLineLength: 64);
        using TextWriter writer = viewer.CreateCaptureWriter(TextWriter.Null, LogStream.Stdout);
        string message = "fail: My.Category[0]\n  " + new string('x', 63) + "\U0001F642" + new string('y', 200) +
            "\n   at Example.Run()\n   at Example.Main()";
        writer.Write(message + "\n");
        writer.Flush();

        Assert.Equal(message, string.Concat(viewer.GetLogs().Select(entry => entry.Message)));
        Assert.All(viewer.GetLogs(), entry =>
        {
            Assert.InRange(entry.Message.Length, 1, 64);
            Assert.False(char.IsHighSurrogate(entry.Message[^1]));
            Assert.Equal(LogSeverity.Error, entry.Severity);
            Assert.Equal("My.Category", entry.Category);
            Assert.True(entry.IsPartial);
        });
    }

    [Theory]
    [InlineData(LogSeverity.Trace)]
    [InlineData(LogSeverity.Debug)]
    [InlineData(LogSeverity.Information)]
    [InlineData(LogSeverity.Warning)]
    [InlineData(LogSeverity.Error)]
    [InlineData(LogSeverity.Critical)]
    public void RecordPreservesOneMultilineEventAndExplicitMetadata(LogSeverity severity)
    {
        using ConsoleLogViewer viewer = StartServer();
        viewer.Record("\u001b[31mFailure\u001b[0m\r\n\r\n  at Example.Run()\rtail",
            LogStream.Stderr, severity, "Recorded.Category");

        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal("Failure\n\n  at Example.Run()\ntail", entry.Message);
        Assert.Equal(LogStream.Stderr, entry.Stream);
        Assert.Equal(severity, entry.Severity);
        Assert.Equal("Recorded.Category", entry.Category);
        Assert.False(entry.IsPartial);
    }

    [Fact]
    public async Task CapturesRealDotnetConsoleLoggerCategoriesScopesAndSeverity()
    {
        TextWriter previousOut = Console.Out;
        TextWriter previousError = Console.Error;
        using StringWriter stdout = new();
        using StringWriter stderr = new();
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            await using ConsoleLogViewer viewer = ConsoleLogViewer.Start();
            using ILoggerFactory factory = LoggerFactory.Create(logging => logging.AddSimpleConsole(options =>
            {
                options.TimestampFormat = "HH:mm:ss.fff ";
                options.IncludeScopes = true;
            }));
            ILogger logger = factory.CreateLogger(LoggerCategory);
            using IDisposable? scope = logger.BeginScope(SyntheticScope);
            logger.LogWarning(LoggerMessage);
            await WaitUntilAsync(() => viewer.GetLogs().Any(entry => entry.Message.Contains(LoggerMessage, StringComparison.Ordinal)));
            LogEntry entry = Assert.Single(viewer.GetLogs(), entry => entry.Message.Contains(LoggerMessage, StringComparison.Ordinal));
            Assert.Equal(LogSeverity.Warning, entry.Severity);
            Assert.Equal(LoggerCategory, entry.Category);
            Assert.Single(viewer.GetLogs());
            Assert.Contains(SyntheticScope, entry.Message, StringComparison.Ordinal);
            Assert.Contains(SyntheticScope, stdout.ToString(), StringComparison.Ordinal);
            Assert.Throws<InvalidOperationException>(() => ConsoleLogViewer.Start());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    [Fact]
    public void DisposalRestoresOwnedWritersButDoesNotOverwriteAReplacement()
    {
        TextWriter previousOut = Console.Out;
        TextWriter previousError = Console.Error;
        using StringWriter replacement = new();
        ConsoleLogViewer viewer = ConsoleLogViewer.Start();
        TextWriter captured = Console.Out;
        Console.SetOut(replacement);
        TextWriter installedReplacement = Console.Out;
        viewer.Dispose();
        try
        {
            Assert.Same(installedReplacement, Console.Out);
            Assert.Same(previousError, Console.Error);
            captured.WriteLine("cached writer still mirrors after disposal");
            Assert.Throws<ObjectDisposedException>(() => viewer.GetLogs());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    [Fact]
    public async Task AsyncWritesCaptureBothStreamsAndFinalPartialOutput()
    {
        await using ConsoleLogViewer viewer = StartServer();
        using StringWriter original = new();
        using TextWriter writer = viewer.CreateCaptureWriter(original, LogStream.Stderr);
        await writer.WriteAsync("Error: async stderr".AsMemory());
        await writer.WriteLineAsync();
        await writer.WriteAsync("tail");
        writer.Dispose();
        Assert.Equal(new[] { "Error: async stderr", "tail" }, viewer.GetLogs().Select(entry => entry.Message));
        Assert.All(viewer.GetLogs(), entry => Assert.Equal(LogStream.Stderr, entry.Stream));
        Assert.All(viewer.GetLogs(), entry => Assert.Equal(LogSeverity.Error, entry.Severity));
    }

    [Fact]
    public void RetentionAndConcurrentWritersPreserveMonotonicIds()
    {
        ViewerSettings settings = new ConsoleLogViewerOptions { Capacity = 128 }.Validate();
        using LogBuffer buffer = new(settings);
        Parallel.For(0, 8, writer =>
        {
            for (int index = 0; index < 1000; index++)
            {
                buffer.Append($"{writer}:{index}", LogStream.Stdout);
            }
        });
        LogSnapshot snapshot = buffer.Snapshot();
        Assert.Equal(128, snapshot.Entries.Length);
        Assert.Equal(8000, snapshot.Status.LastId);
        Assert.Equal(7872, snapshot.Status.EvictedCount);
        Assert.Equal(Enumerable.Range(7873, 128).Select(value => (long)value), snapshot.Entries.Select(entry => entry.Id));
    }

    [Fact]
    public void DefaultHistoryKeepsConcurrentWritesBeyondOneHundredThousandEntries()
    {
        using LogBuffer buffer = new(new ConsoleLogViewerOptions().Validate());
        Parallel.For(0, UnlimitedWriterCount, writer =>
        {
            for (int index = 0; index < EntriesPerUnlimitedWriter; index++)
            {
                buffer.Append($"{writer}:{index}", LogStream.Stdout);
            }
        });

        int expectedCount = UnlimitedWriterCount * EntriesPerUnlimitedWriter;
        LogSnapshot snapshot = buffer.Snapshot();
        Assert.Equal(expectedCount, snapshot.Entries.Length);
        Assert.Equal(0, snapshot.Status.Capacity);
        Assert.Equal(expectedCount, snapshot.Status.RetainedCount);
        Assert.Equal(expectedCount, snapshot.Status.LastId);
        Assert.Equal(1, snapshot.Status.FirstId);
        Assert.Equal(0, snapshot.Status.EvictedCount);
        Assert.Equal(Enumerable.Range(1, expectedCount).Select(value => (long)value), snapshot.Entries.Select(entry => entry.Id));
        Assert.Equal(snapshot.Status, buffer.GetStatus());

        long cursor = 0;
        do
        {
            LogBatch batch = buffer.ReadAfter(cursor);
            Assert.Equal(0, batch.MissedCount);
            Assert.InRange(batch.Entries.Length, 1, ViewerConstants.StreamBatchSize);
            Assert.Equal(cursor + 1, batch.Entries[0].Id);
            cursor = batch.Entries[^1].Id;
            Assert.Equal(cursor < expectedCount, batch.HasMore);
        }
        while (cursor < expectedCount);
    }

    [Fact]
    public void ExplicitCapacityCanExceedThePreviousMaximum()
    {
        using ConsoleLogViewer viewer = StartServer(capacity: CapacityAbovePreviousMaximum);
        viewer.Record("retained-entry");
        Assert.Equal("retained-entry", Assert.Single(viewer.GetLogs()).Message);
    }

    [Theory]
    [InlineData("info: My.Category[42]", LogSeverity.Information, "My.Category")]
    [InlineData("12:20:33.123 warn: My.Category[0]", LogSeverity.Warning, "My.Category")]
    [InlineData("[ERR] an error", LogSeverity.Error, null)]
    [InlineData("Error: skill failed", LogSeverity.Error, null)]
    [InlineData("!! System.InvalidOperationException", LogSeverity.Error, null)]
    [InlineData("{\"LogLevel\":\"Critical\",\"Category\":\"Json.Category\",\"Message\":\"failure\"}", LogSeverity.Critical, "Json.Category")]
    [InlineData("ordinary text containing info: inside a sentence", LogSeverity.Output, null)]
    [InlineData("{not-json", LogSeverity.Output, null)]
    public void SeverityInferenceIsPrefixBased(string message, LogSeverity severity, string? category)
    {
        using ConsoleLogViewer viewer = StartServer();
        viewer.Record(message);
        LogEntry entry = Assert.Single(viewer.GetLogs());
        Assert.Equal(severity, entry.Severity);
        Assert.Equal(category, entry.Category);
    }

    [Fact]
    public void OptionValidationIsExplicitAndSettingsAreCopiedAtStart()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => ConsoleLogViewer.Start(new ConsoleLogViewerOptions { Capacity = -1 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => ConsoleLogViewer.Start(new ConsoleLogViewerOptions { FlushEveryEntries = 0 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => ConsoleLogViewer.Start(new ConsoleLogViewerOptions { Port = 65536 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => ConsoleLogViewer.Start(new ConsoleLogViewerOptions { MaxLineLength = 1 }));
        ConsoleLogViewerOptions options = new() { CaptureConsole = false, Capacity = 2 };
        using ConsoleLogViewer viewer = ConsoleLogViewer.Start(options);
        options.Capacity = 100;
        viewer.Record("one");
        viewer.Record("two");
        viewer.Record("three");
        Assert.Equal(new[] { "two", "three" }, viewer.GetLogs().Select(entry => entry.Message));
    }

#if MEDEINA_COLOR_CONSOLE
    [Fact]
    public void CapturesExistingMedeinaColorConsoleWithoutChangingItsCode()
    {
        TextWriter previousOut = Console.Out;
        using StringWriter original = new();
        Console.SetOut(original);
        try
        {
            using ConsoleLogViewer viewer = ConsoleLogViewer.Start();
            Microsoft.Medeina.Test.Console.Color.ColorConsole.WriteLine(ConsoleColor.Cyan, "SessionId: demo-session\nEvaluation log");
            Microsoft.Medeina.Test.Console.Color.ColorConsole.Write(ConsoleColor.White, "Prompt> ");
            Console.Out.Flush();
            Assert.Equal(new[] { "SessionId: demo-session", "Evaluation log", "Prompt> " }, viewer.GetLogs().Select(entry => entry.Message));
            Assert.Equal($"SessionId: demo-session{Environment.NewLine}Evaluation log{Environment.NewLine}Prompt> ", original.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
        }
    }
#endif

    internal static ConsoleLogViewer StartServer(int capacity = 0, int maxLineLength = 16384) =>
        ConsoleLogViewer.Start(new ConsoleLogViewerOptions
        {
            CaptureConsole = false,
            Capacity = capacity,
            MaxLineLength = maxLineLength,
            ApplicationName = "Viewer tests",
        });

    internal static async Task WaitUntilAsync(Func<bool> predicate)
    {
        using System.Threading.CancellationTokenSource timeout = new(TimeSpan.FromSeconds(5));
        while (!predicate())
        {
            await Task.Delay(20, timeout.Token);
        }
    }
}
