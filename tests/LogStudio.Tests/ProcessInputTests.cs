using System;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class ProcessInputTests
{
    [Fact]
    public async Task BrowserLinesPreserveEmptyWhitespaceUnicodeAndTheLengthBoundaryWithoutRecordingInput()
    {
        using MemoryStream pipe = new();
        using ProcessInput input = new();
        input.Attach(pipe);
        await using ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        string[] lines = { "", " \t ", "日本語 café 🙂", new('x', ProcessInput.MaximumTextLength) };
        foreach (string text in lines)
        {
            using HttpRequestMessage request = InputRequest(viewer.Url, JsonSerializer.Serialize(new { text }));
            using HttpResponseMessage response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            using JsonDocument result = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.True(result.RootElement.GetProperty("sent").GetBoolean());
        }
        Assert.Equal(Encoding.UTF8.GetBytes(string.Join(Environment.NewLine, lines) + Environment.NewLine), pipe.ToArray());
        Assert.Empty(viewer.GetLogs());
        Assert.Empty(File.ReadAllText(Path.Combine(viewer.HistoryDirectory, "entries.jsonl")));
    }

    [Theory]
    [InlineData(28591, "café £")]
    [InlineData(20127, "ASCII \t input")]
    [InlineData(65001, "日本語 café 🙂")]
    [InlineData(1200, "日本語 café 🙂")]
    public async Task BrowserLinesUseTheAttachedEncodingWithoutBomOrChangingRawTerminalBytes(int codePage, string text)
    {
        using MemoryStream pipe = new();
        using ProcessInput input = new();
        Encoding encoding = Encoding.GetEncoding(codePage);
        input.Attach(pipe, encoding);
        byte[] raw = { 0xff, 0, 0x80, 13, 10 };
        await input.WriteAsync(raw, CancellationToken.None);
        await using ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        using HttpRequestMessage request = InputRequest(viewer.Url, JsonSerializer.Serialize(new { text }));
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using MemoryStream expected = new();
        expected.Write(raw);
        expected.Write(encoding.GetBytes(text + Environment.NewLine));
        Assert.Equal(expected.ToArray(), pipe.ToArray());
    }

    [Theory]
    [InlineData(28591, "private-input日本語🙂")]
    [InlineData(20127, "private-inputcafé")]
    public async Task UnrepresentableInputIsRejectedBeforeWritingWithoutEchoOrClosingStdin(int codePage, string text)
    {
        using MemoryStream pipe = new();
        using ProcessInput input = new();
        Encoding encoding = (Encoding)Encoding.GetEncoding(codePage).Clone();
        input.Attach(pipe, encoding);
        encoding.EncoderFallback = new EncoderReplacementFallback("replacement");
        await using ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        using HttpRequestMessage request = InputRequest(viewer.Url, JsonSerializer.Serialize(new { text }));
        using HttpResponseMessage response = await client.SendAsync(request);
        await AssertErrorAsync(response, HttpStatusCode.BadRequest);
        string error = await response.Content.ReadAsStringAsync();
        Assert.Contains("standard input encoding", error, StringComparison.Ordinal);
        Assert.Empty(pipe.ToArray());
        Assert.True(input.CanWrite);
        using HttpRequestMessage retry = InputRequest(viewer.Url, "{\"text\":\"safe\"}");
        using HttpResponseMessage accepted = await client.SendAsync(retry);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        Assert.Equal(Encoding.ASCII.GetBytes("safe" + Environment.NewLine), pipe.ToArray());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("{")]
    [InlineData("{\"text\":null}")]
    [InlineData("{\"text\":123}")]
    [InlineData("{\"Text\":\"private-input\"}")]
    [InlineData("{\"text\":\"\",\"text\":\"private-input\"}")]
    [InlineData("{\"text\":\"private-input\",\"sessionId\":\"old\"}")]
    [InlineData("{\"text\":\"private-input\\n\"}")]
    [InlineData("{\"text\":\"private-input\\r\"}")]
    [InlineData("{\"text\":\"private-input\\u0000\"}")]
    [InlineData("{\"text\":\"private-input\\u001b\"}")]
    [InlineData("{\"text\":\"private-input\\u007f\"}")]
    [InlineData("{\"text\":\"private-input\\u0085\"}")]
    [InlineData("{\"text\":\"private-input\\ud800\"}")]
    public async Task InvalidInputNeverWritesOrEchoesSubmittedContent(string json)
    {
        using MemoryStream pipe = new();
        using ProcessInput input = new();
        input.Attach(pipe);
        await using ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        using HttpRequestMessage request = InputRequest(viewer.Url, json);
        using HttpResponseMessage response = await client.SendAsync(request);
        await AssertErrorAsync(response, HttpStatusCode.BadRequest);
        Assert.Empty(pipe.ToArray());
        Assert.True(input.CanWrite);
    }

    [Fact]
    public async Task InputRequiresTheCorrectRouteSameOriginActionMethodAndLiveSession()
    {
        using MemoryStream pipe = new();
        using ProcessInput input = new();
        input.Attach(pipe);
        await using ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        foreach ((string route, string? action, string? origin, HttpMethod method, string contentType, HttpStatusCode expected) in new[]
        {
            ("api/input", (string?)"input", (string?)null, HttpMethod.Get, "application/json", HttpStatusCode.MethodNotAllowed),
            ("api/input", null, null, HttpMethod.Post, "application/json", HttpStatusCode.Forbidden),
            ("api/input", "clear", null, HttpMethod.Post, "application/json", HttpStatusCode.Forbidden),
            ("api/input", "input", "https://other.invalid", HttpMethod.Post, "application/json", HttpStatusCode.Forbidden),
            ("api/input?sessionId=old", "input", null, HttpMethod.Post, "application/json", HttpStatusCode.BadRequest),
            ("api/input?sessionId=", "input", null, HttpMethod.Post, "application/json", HttpStatusCode.BadRequest),
            ("api/input?SESSIONID=old", "input", null, HttpMethod.Post, "application/json", HttpStatusCode.BadRequest),
            ("/unknown/api/input", "input", null, HttpMethod.Get, "application/json", HttpStatusCode.NotFound),
            ("api/input", "input", null, HttpMethod.Post, "text/plain", HttpStatusCode.UnsupportedMediaType),
        })
        {
            using HttpRequestMessage request = InputRequest(viewer.Url, "{\"text\":\"private-input\"}", route);
            request.Method = method;
            request.Headers.Remove(ViewerConstants.ClearRequestHeader);
            if (action is not null) request.Headers.Add(ViewerConstants.ClearRequestHeader, action);
            if (origin is not null) request.Headers.Add(ViewerConstants.OriginHeader, origin);
            request.Content!.Headers.ContentType!.MediaType = contentType;
            using HttpResponseMessage response = await client.SendAsync(request);
            await AssertErrorAsync(response, expected);
        }
        Assert.Empty(pipe.ToArray());
    }

    [Fact]
    public async Task InputBoundsDecodedCharactersAndActualBytesIncludingChunkedRequests()
    {
        using MemoryStream pipe = new();
        using ProcessInput input = new();
        input.Attach(pipe);
        await using ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        using (HttpRequestMessage request = InputRequest(viewer.Url, JsonSerializer.Serialize(new { text = new string('x', 4097) })))
        using (HttpResponseMessage response = await client.SendAsync(request))
            await AssertErrorAsync(response, HttpStatusCode.BadRequest);
        foreach (bool chunked in new[] { false, true })
        {
            using HttpRequestMessage request = InputRequest(viewer.Url, new string(' ', 32768) + "{\"text\":\"private-input\"}");
            request.Headers.TransferEncodingChunked = chunked;
            using HttpResponseMessage response = await client.SendAsync(request);
            await AssertErrorAsync(response, HttpStatusCode.RequestEntityTooLarge);
        }
        Assert.Empty(pipe.ToArray());
        const string body = "{\"text\":\"\"}";
        using HttpRequestMessage boundary = InputRequest(viewer.Url, new string(' ', 32768 - body.Length) + body);
        boundary.Headers.TransferEncodingChunked = true;
        using HttpResponseMessage accepted = await client.SendAsync(boundary);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        Assert.Equal(Encoding.UTF8.GetBytes(Environment.NewLine), pipe.ToArray());
    }

    [Fact]
    public async Task ClosedCompletedUnsupportedAndFailedPipeInputRemainUnavailable()
    {
        using HttpClient client = new();
        await using (ConsoleLogViewer unsupported = StartViewer())
        {
            Assert.False(await CanWriteAsync(client, unsupported.Url));
            using HttpRequestMessage request = InputRequest(unsupported.Url);
            using HttpResponseMessage response = await client.SendAsync(request);
            await AssertErrorAsync(response, HttpStatusCode.Conflict);
        }
        foreach (string state in new[] { "closed", "completed", "disposed-stream" })
        {
            using MemoryStream pipe = new();
            using ProcessInput input = new();
            input.Attach(pipe);
            await using ConsoleLogViewer viewer = StartViewer(input);
            Assert.True(await CanWriteAsync(client, viewer.Url));
            if (state == "closed") input.Close();
            if (state == "completed") viewer.Complete();
            if (state == "disposed-stream") pipe.Dispose();
            if (state != "disposed-stream") Assert.False(await CanWriteAsync(client, viewer.Url));
            using HttpRequestMessage request = InputRequest(viewer.Url);
            using HttpResponseMessage response = await client.SendAsync(request);
            await AssertErrorAsync(response, HttpStatusCode.Conflict);
            Assert.False(await CanWriteAsync(client, viewer.Url));
            Assert.Empty(pipe.ToArray());
        }
    }

    [Fact]
    public async Task AvailabilityChangesWakeIdleStatusStreams()
    {
        using MemoryStream pipe = new();
        using ProcessInput input = new();
        await using ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.UpdatesRoute), HttpCompletionOption.ResponseHeadersRead);
        using StreamReader reader = new(await response.Content.ReadAsStreamAsync());
        JsonElement initial = await ReadStatusAsync(reader);
        Assert.False(initial.GetProperty("canWriteInput").GetBoolean());
        input.Attach(pipe);
        JsonElement attached = await ReadStatusAsync(reader);
        Assert.True(attached.GetProperty("canWriteInput").GetBoolean());
        Assert.True(attached.GetProperty("revision").GetInt64() > initial.GetProperty("revision").GetInt64());
        input.Close();
        Assert.False((await ReadStatusAsync(reader)).GetProperty("canWriteInput").GetBoolean());
    }

    [Fact]
    public async Task StatusDoesNotProbeExitCallbacksAndConcurrentExitNotificationsDoNotDeadlock()
    {
        using ExitNotifyingStream pipe = new();
        using ProcessInput input = new();
        input.Attach(pipe);
        ViewerSettings settings = new ConsoleLogViewerOptions { CaptureConsole = false, Input = input }.Validate();
        using LogBuffer logs = new(settings);
        input.Changed += () =>
        {
            ViewerStatus status = Task.Run(logs.GetStatus).WaitAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult();
            Assert.False(status.CanWriteInput);
        };
        pipe.AvailabilityRead = input.Close;
        await input.WriteAsync(new byte[] { 1 }, CancellationToken.None);
        Assert.True(logs.GetStatus().CanWriteInput);
        Assert.Equal(0, pipe.AvailabilityReads);
        Task statusReads = Task.Run(() =>
        {
            for (int index = 0; index < 10000; index++) logs.GetStatus();
        });
        Task exitNotification = Task.Run(input.Close);
        await Task.WhenAll(statusReads, exitNotification).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(logs.GetStatus().CanWriteInput);
        Assert.Equal(0, pipe.AvailabilityReads);
    }

    [Fact]
    public async Task BlockedInputTimesOutAndRejectsConcurrentHttpRequestsWithoutHangingShutdown()
    {
        using BlockingStream pipe = new();
        using ProcessInput input = new(TimeSpan.FromMilliseconds(300));
        input.Attach(pipe);
        await using ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        using HttpRequestMessage first = InputRequest(viewer.Url);
        Task<HttpResponseMessage> pending = client.SendAsync(first);
        await pipe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using HttpRequestMessage second = InputRequest(viewer.Url);
        using (HttpResponseMessage busy = await client.SendAsync(second))
            await AssertErrorAsync(busy, HttpStatusCode.TooManyRequests);
        using (HttpResponseMessage timedOut = await pending.WaitAsync(TimeSpan.FromSeconds(5)))
            await AssertErrorAsync(timedOut, HttpStatusCode.RequestTimeout);
        Assert.False(await CanWriteAsync(client, viewer.Url));
        await viewer.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task TerminalBytesAndBrowserLinesShareOneWriter()
    {
        using SlowStream pipe = new();
        using ProcessInput input = new();
        input.Attach(pipe);
        byte[] raw = { 0, 255, 13, 10, 1, 2, 3 };
        Task terminal = input.WriteAsync(raw, CancellationToken.None);
        Task browser = input.SendLineAsync("🙂", CancellationToken.None);
        await Task.WhenAll(terminal, browser);
        Assert.False(pipe.ConcurrentWrites);
        byte[] expected = new byte[raw.Length + Encoding.UTF8.GetByteCount("🙂" + Environment.NewLine)];
        raw.CopyTo(expected, 0);
        Encoding.UTF8.GetBytes("🙂" + Environment.NewLine).CopyTo(expected, raw.Length);
        Assert.Equal(expected, pipe.ToArray());
    }

    [Fact]
    public async Task FullOperatingSystemPipeCannotHangInputOrClose()
    {
        using AnonymousPipeServerStream pipe = new(PipeDirection.Out);
        using AnonymousPipeClientStream reader = new(PipeDirection.In, pipe.GetClientHandleAsString());
        using ProcessInput input = new(TimeSpan.FromMilliseconds(150));
        input.Attach(pipe);
        Task fill = Task.Run(async () =>
        {
            while (true) await input.SendLineAsync(new string('x', 4096), CancellationToken.None);
        });
        await Assert.ThrowsAsync<TimeoutException>(() => fill.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.False(input.CanWrite);
    }

    [Fact]
    public async Task ViewerDisposalCancelsPendingInput()
    {
        using BlockingStream pipe = new();
        using ProcessInput input = new();
        input.Attach(pipe);
        ConsoleLogViewer viewer = StartViewer(input);
        using HttpClient client = new();
        using HttpRequestMessage request = InputRequest(viewer.Url);
        Task<HttpResponseMessage> pending = client.SendAsync(request);
        await pipe.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await viewer.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        using HttpResponseMessage response = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(input.CanWrite);
    }

    [Fact]
    public void LegacyStatusDefaultsToReadOnlyAndSavedStatusNeverAdvertisesInput()
    {
        string directory = Path.Combine(Environment.CurrentDirectory, ".input-sessions-" + Guid.NewGuid().ToString("N"));
        using MemoryStream pipe = new();
        using ProcessInput input = new();
        input.Attach(pipe);
        ViewerSettings settings = new ConsoleLogViewerOptions
        {
            CaptureConsole = false, SaveSession = true, SessionsDirectory = directory, Input = input,
        }.Validate();
        try
        {
            using LogBuffer logs = new(settings);
            Assert.True(logs.GetStatus().CanWriteInput);
            System.Text.Json.Nodes.JsonNode legacy = JsonSerializer.SerializeToNode(logs.GetStatus(), ViewerConstants.JsonOptions)!;
            legacy.AsObject().Remove("canWriteInput");
            Assert.False(legacy.Deserialize<ViewerStatus>(ViewerConstants.JsonOptions)!.CanWriteInput);
            SessionCatalog sessions = new(settings);
            sessions.Save(logs);
            using LogHistoryReader saved = sessions.Open(sessions.Id);
            Assert.False(saved.Status.CanWriteInput);
            using JsonDocument metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, sessions.Id, "session.json")));
            Assert.False(metadata.RootElement.GetProperty("status").GetProperty("canWriteInput").GetBoolean());
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }

    private static ConsoleLogViewer StartViewer(ProcessInput? input = null) =>
        ConsoleLogViewer.Start(new ConsoleLogViewerOptions { CaptureConsole = false, Input = input });

    private static HttpRequestMessage InputRequest(Uri url, string json = "{\"text\":\"private-input\"}", string route = "api/input")
    {
        HttpRequestMessage request = new(HttpMethod.Post, new Uri(url, route));
        request.Headers.Add(ViewerConstants.ClearRequestHeader, "input");
        request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        return request;
    }

    private static async Task AssertErrorAsync(HttpResponseMessage response, HttpStatusCode expected)
    {
        Assert.Equal(expected, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        string body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("private-input", body, StringComparison.Ordinal);
        using JsonDocument error = JsonDocument.Parse(body);
        Assert.False(string.IsNullOrWhiteSpace(error.RootElement.GetProperty("error").GetString()));
    }

    private static async Task<bool> CanWriteAsync(HttpClient client, Uri url)
    {
        using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, ViewerConstants.SnapshotRoute)));
        return snapshot.RootElement.GetProperty("status").GetProperty("canWriteInput").GetBoolean();
    }

    private static async Task<JsonElement> ReadStatusAsync(StreamReader reader)
    {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(5));
        while (true)
        {
            string? line = await reader.ReadLineAsync(timeout.Token);
            Assert.NotNull(line);
            if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;
            using JsonDocument status = JsonDocument.Parse(line[6..]);
            return status.RootElement.Clone();
        }
    }

    private sealed class BlockingStream : MemoryStream
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            this.Entered.TrySetResult();
            return new ValueTask(this.released.Task);
        }

        protected override void Dispose(bool disposing)
        {
            this.released.TrySetResult();
            base.Dispose(disposing);
        }
    }

    private sealed class ExitNotifyingStream : MemoryStream
    {
        internal Action? AvailabilityRead { get; set; }
        internal int AvailabilityReads { get; private set; }

        public override bool CanWrite
        {
            get
            {
                this.AvailabilityReads++;
                this.AvailabilityRead?.Invoke();
                return base.CanWrite;
            }
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) =>
            ValueTask.CompletedTask;
    }

    private sealed class SlowStream : MemoryStream
    {
        private int writing;
        internal bool ConcurrentWrites { get; private set; }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Interlocked.Increment(ref this.writing) > 1) this.ConcurrentWrites = true;
            for (int index = 0; index < buffer.Length; index++)
            {
                this.WriteByte(buffer.Span[index]);
                await Task.Yield();
            }
            Interlocked.Decrement(ref this.writing);
        }
    }
}
