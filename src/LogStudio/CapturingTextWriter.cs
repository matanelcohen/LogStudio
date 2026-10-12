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
            if (this.pending.Length > 0 &&
                Stopwatch.GetElapsedTime(this.lastWrite) >= ViewerConstants.PartialLineInterval)
            {
                this.PublishPartial();
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
                    this.logs.Append(this.pending.ToString(), this.stream);
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

        this.logs.Append(this.pending.ToString(), this.stream, isPartial: true);
        this.pending.Clear();
        this.partialWasPublished = true;
    }
}
