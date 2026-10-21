using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed class CapturingTextWriter : TextWriter
{
    private readonly object gate = new();
    private readonly TextWriter original;
    private readonly LogBuffer logs;
    private readonly LogStream stream;
    private readonly int maxLineLength;
    private readonly StringBuilder pending = new();
    private readonly StringBuilder entry = new();
    private LogSeverity entrySeverity;
    private string? entryCategory;
    private bool hasEntry;
    private bool entryHasLine;
    private bool entryIsPartial;
    private bool acceptsException;
    private long lastWrite;
    private bool previousWasCarriageReturn;
    private bool partialWasPublished;
    private bool closed;

    internal CapturingTextWriter(TextWriter original, LogBuffer logs, LogStream stream, int maxLineLength)
    {
        this.original = original;
        this.logs = logs;
        this.stream = stream;
        this.maxLineLength = maxLineLength;
        this.NewLine = original.NewLine;
    }

    public override Encoding Encoding => this.original.Encoding;

    public override IFormatProvider FormatProvider => this.original.FormatProvider;

    public override void Write(char value)
    {
        Span<char> character = stackalloc char[1];
        character[0] = value;
        this.Write(character);
    }

    public override void Write(string? value) => this.Write(value.AsSpan());

    public override void Write(char[] buffer, int index, int count) => this.Write(buffer.AsSpan(index, count));

    public override void Write(ReadOnlySpan<char> buffer)
    {
        lock (this.gate)
        {
            this.original.Write(buffer);
            this.Capture(buffer);
        }
    }

    public override void WriteLine(string? value) => this.WriteLine(value.AsSpan());

    public override void WriteLine(ReadOnlySpan<char> buffer)
    {
        lock (this.gate)
        {
            this.original.WriteLine(buffer);
            this.Capture(buffer);
            this.Capture(this.NewLine.AsSpan());
        }
    }

    public override Task WriteAsync(char value)
    {
        this.Write(value);
        return Task.CompletedTask;
    }

    public override Task WriteAsync(string? value)
    {
        this.Write(value);
        return Task.CompletedTask;
    }

    public override Task WriteAsync(char[] buffer, int index, int count)
    {
        this.Write(buffer, index, count);
        return Task.CompletedTask;
    }

    public override Task WriteAsync(ReadOnlyMemory<char> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        this.Write(buffer.Span);
        return Task.CompletedTask;
    }

    public override Task WriteLineAsync(string? value)
    {
        this.WriteLine(value);
        return Task.CompletedTask;
    }

    public override Task WriteLineAsync(ReadOnlyMemory<char> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        this.WriteLine(buffer.Span);
        return Task.CompletedTask;
    }

    public override void Flush()
    {
        lock (this.gate)
        {
            this.original.Flush();
            this.PublishPartial();
            this.PublishEntry();
        }
    }

    public override Task FlushAsync()
    {
        this.Flush();
        return Task.CompletedTask;
    }

    internal void FlushIdle()
    {
        lock (this.gate)
        {
            if ((this.pending.Length > 0 || this.hasEntry) &&
                Stopwatch.GetElapsedTime(this.lastWrite) >= ViewerConstants.PartialLineInterval)
            {
                this.PublishPartial();
                this.PublishEntry();
            }
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            lock (this.gate)
            {
                this.PublishPartial();
                this.PublishEntry();
                this.closed = true;
            }
        }

        base.Dispose(disposing);
    }

    private void Capture(ReadOnlySpan<char> buffer)
    {
        if (this.closed)
        {
            return;
        }

        this.lastWrite = Stopwatch.GetTimestamp();
        foreach (char character in buffer)
        {
            if (character == '\n' && this.previousWasCarriageReturn)
            {
                this.previousWasCarriageReturn = false;
                continue;
            }

            if (character is '\r' or '\n')
            {
                if (this.pending.Length > 0 || !this.partialWasPublished)
                {
                    this.CaptureLine(this.pending.ToString(), isPartial: false);
                }

                this.pending.Clear();
                this.partialWasPublished = false;
                this.previousWasCarriageReturn = character == '\r';
                continue;
            }

            this.previousWasCarriageReturn = false;
            this.pending.Append(character);
            if (this.pending.Length >= this.maxLineLength && !char.IsHighSurrogate(character))
            {
                this.PublishPartial();
            }
        }
    }

    private void PublishPartial()
    {
        if (this.closed || this.pending.Length == 0)
        {
            return;
        }

        this.CaptureLine(this.pending.ToString(), isPartial: true);
        this.pending.Clear();
        this.partialWasPublished = true;
    }

    private void CaptureLine(string line, bool isPartial)
    {
        string clean = LogParser.StripTerminalEscapes(line);
        bool header = LogParser.TryParseHeader(clean, out LogSeverity severity, out string? category);
        bool exception = LogParser.IsExceptionStart(clean);
        bool continuation = LogParser.IsContinuation(clean);
        if (this.hasEntry && !this.partialWasPublished &&
            !((!header && continuation) || (exception && (continuation || this.acceptsException))))
        {
            this.PublishEntry();
        }

        if (!this.hasEntry)
        {
            if (!header && !continuation)
            {
                this.logs.Append(clean, this.stream, isPartial);
                return;
            }

            this.hasEntry = true;
            this.entrySeverity = header ? severity : this.stream == LogStream.Stderr ? LogSeverity.Error :
                this.stream == LogStream.Viewer ? LogSeverity.Information : LogSeverity.Output;
            this.entryCategory = category;
            this.acceptsException = header && !exception;
        }

        if (this.entryHasLine && !this.partialWasPublished) this.entry.Append('\n');
        this.entry.Append(clean);
        this.entryHasLine = true;
        this.entryIsPartial |= isPartial;
        if (exception) this.acceptsException = false;
        if (this.entry.Length >= this.maxLineLength) this.PublishEntry(isPartial: true, reset: false);
    }

    private void PublishEntry(bool isPartial = false, bool reset = true)
    {
        if (this.entry.Length > 0)
        {
            this.logs.Append(this.entry.ToString(), this.stream, isPartial || this.entryIsPartial,
                this.entrySeverity, this.entryCategory);
            this.entry.Clear();
        }

        if (reset)
        {
            this.hasEntry = false;
            this.entryHasLine = false;
            this.entryIsPartial = false;
            this.entryCategory = null;
            this.acceptsException = false;
        }
        else
        {
            this.entryIsPartial = true;
        }
    }
}
