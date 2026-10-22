using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed class ProcessInput : IDisposable
{
    internal const int MaximumTextLength = 4096;
    private readonly object gate = new();
    private readonly SemaphoreSlim writer = new(1);
    private readonly CancellationTokenSource closed = new();
    private readonly TimeSpan writeTimeout;
    private Stream? destination;
    private Encoding encoding = new UTF8Encoding(false, true);
    private bool stopped;

    internal ProcessInput(TimeSpan? writeTimeout = null)
    {
        this.writeTimeout = writeTimeout ?? TimeSpan.FromSeconds(5);
    }

    internal event Action? Changed;

    internal bool CanWrite
    {
        get
        {
            // Liveness probes can synchronously raise exit notifications; only inspect cached state here.
            lock (this.gate)
                return !this.stopped && this.destination is not null;
        }
    }

    internal void Attach(Stream destination, Encoding? encoding = null)
    {
        ArgumentNullException.ThrowIfNull(destination);
        Encoding strictEncoding = (Encoding)(encoding ?? this.encoding).Clone();
        strictEncoding.EncoderFallback = EncoderFallback.ExceptionFallback;
        lock (this.gate)
        {
            if (this.stopped) throw new InvalidOperationException("Standard input has already closed.");
            if (this.destination is not null) throw new InvalidOperationException("Standard input is already attached.");
            this.destination = destination;
            this.encoding = strictEncoding;
        }
        this.Changed?.Invoke();
    }

    internal static void ValidateText(string text)
    {
        if (text.Length > MaximumTextLength)
            throw new ArgumentException("Input must contain at most 4096 characters.");
        for (int index = 0; index < text.Length; index++)
        {
            char value = text[index];
            if (char.IsControl(value) && value != '\t')
                throw new ArgumentException("Input must be a single line without control characters other than tab.");
            if (char.IsHighSurrogate(value))
            {
                if (++index < text.Length && char.IsLowSurrogate(text[index])) continue;
                throw new ArgumentException("Input must contain valid Unicode.");
            }
            if (char.IsLowSurrogate(value)) throw new ArgumentException("Input must contain valid Unicode.");
        }
    }

    internal async Task SendLineAsync(string text, CancellationToken cancellationToken)
    {
        ValidateText(text);
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(this.writeTimeout);
        Encoding inputEncoding;
        lock (this.gate) inputEncoding = this.encoding;
        byte[] bytes;
        try
        {
            bytes = inputEncoding.GetBytes(text + Environment.NewLine);
        }
        catch (EncoderFallbackException)
        {
            throw new ArgumentException("Input contains characters unavailable in the wrapped program's standard input encoding.");
        }
        try
        {
            await this.WriteAsync(bytes, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && timeout.IsCancellationRequested)
        {
            this.Close();
            throw new TimeoutException("Input timed out; standard input has been closed.");
        }
        finally
        {
            Array.Clear(bytes);
        }
    }

    internal async Task WriteAsync(ReadOnlyMemory<byte> bytes, CancellationToken cancellationToken)
    {
        using CancellationTokenSource cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, this.closed.Token);
        bool entered = false;
        try
        {
            await this.writer.WaitAsync(cancellation.Token).ConfigureAwait(false);
            entered = true;
            Stream target;
            lock (this.gate)
            {
                if (this.stopped || this.destination is null) throw new IOException("Standard input is unavailable.");
                target = this.destination;
            }

            // Both raw terminal chunks and complete browser lines use this same write gate.
            await target.WriteAsync(bytes, cancellation.Token).AsTask().WaitAsync(cancellation.Token).ConfigureAwait(false);
            await target.FlushAsync(cancellation.Token).WaitAsync(cancellation.Token).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or OperationCanceledException)
        {
            this.Close();
            throw;
        }
        finally
        {
            if (entered) this.writer.Release();
        }
    }

    internal void Close()
    {
        Stream? target;
        lock (this.gate)
        {
            if (this.stopped) return;
            this.stopped = true;
            target = this.destination;
            this.destination = null;
        }
        this.closed.Cancel();
        this.Changed?.Invoke();
        try
        {
            target?.Dispose();
        }
        catch (IOException)
        {
        }
    }

    public void Dispose() => this.Close();
}
