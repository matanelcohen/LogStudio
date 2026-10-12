using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed class HttpLogServer : IAsyncDisposable
{
    private const int LinuxAddressInUse = 98;
    private const int MacAddressInUse = 48;
    private const int WindowsAlreadyExists = 183;
    private const int MaximumHistoryRequests = 4;
    private const string NotFoundMessage = "Not found.";
    private const string Heartbeat = ": heartbeat\n\n";
    private const string EventPrefix = "event: ";
    private const string DataPrefix = "data: ";
    private const string IdPrefix = "id: ";
    private const string LineEnding = "\n";
    private const string RootRoute = "";
    private const string ContentSecurityPolicy =
        "default-src 'none'; script-src 'self' 'nonce-{0}'; style-src 'self' 'nonce-{0}'; connect-src 'self'; " +
        "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; style-src-attr 'unsafe-inline'";

    private readonly HttpListener listener;
    private readonly LogBuffer logs;
    private readonly TextWriter diagnostics;
    private readonly Func<LogClearResult> clearLogs;
    private readonly SessionCatalog sessions;
    private readonly string pathPrefix;
    private readonly string authority;
    private readonly string contentSecurityPolicy;
    private readonly Dictionary<string, Asset> assets;
    private readonly CancellationTokenSource shutdown = new();
    private readonly SemaphoreSlim streamSlots = new(ViewerConstants.MaximumLiveClients);
    private readonly SemaphoreSlim historySlots = new(MaximumHistoryRequests);
    private readonly SemaphoreSlim copilotSlot = new(1);
    private readonly CopilotCliClient copilot;
    private readonly ConcurrentDictionary<Task, byte> requests = new();
    private readonly Task acceptTask;

    internal HttpLogServer(ViewerSettings settings, LogBuffer logs, TextWriter diagnostics, Func<LogClearResult> clearLogs, SessionCatalog sessions, CopilotCliClient? copilot = null)
    {
        this.logs = logs;
        this.diagnostics = diagnostics;
        this.clearLogs = clearLogs;
        this.sessions = sessions;
        this.copilot = copilot ?? new CopilotCliClient();
        this.pathPrefix = $"/{Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant()}/";
        string nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
        this.contentSecurityPolicy = string.Format(CultureInfo.InvariantCulture, ContentSecurityPolicy, nonce);
        this.assets = LoadAssets(nonce);
        (this.listener, int port) = Bind(settings.Port);
        this.authority = $"http://{ViewerConstants.LoopbackHost}:{port}";
        this.Url = new Uri(this.authority + this.pathPrefix);
        this.acceptTask = this.AcceptAsync();
    }

    internal Uri Url { get; }

    public async ValueTask DisposeAsync()
    {
        this.shutdown.Cancel();
        this.listener.Close();
        await this.acceptTask.ConfigureAwait(false);
        await Task.WhenAll(this.requests.Keys).ConfigureAwait(false);
        this.streamSlots.Dispose();
        this.historySlots.Dispose();
        this.copilotSlot.Dispose();
        this.shutdown.Dispose();
    }

    private static (HttpListener Listener, int Port) Bind(int requestedPort)
    {
        for (int attempt = 0; attempt < ViewerConstants.AutomaticPortAttempts; attempt++)
        {
            int port = requestedPort;
            if (port == 0)
            {
                using TcpListener reservation = new(IPAddress.Loopback, 0);
                reservation.Start();
                port = ((IPEndPoint)reservation.LocalEndpoint).Port;
                reservation.Stop();
            }

            HttpListener listener = new();
            listener.Prefixes.Add($"http://{ViewerConstants.LoopbackHost}:{port}/");
            bool bound = false;
            try
            {
                listener.Start();
                bound = true;
                return (listener, port);
            }
            catch (HttpListenerException exception) when (
                requestedPort == 0 &&
                attempt + 1 < ViewerConstants.AutomaticPortAttempts &&
                exception.NativeErrorCode is LinuxAddressInUse or MacAddressInUse or WindowsAlreadyExists)
            {
                // Port selection and HttpListener binding are separate operations; retry only a bind collision.
            }
            finally
            {
                if (!bound)
                {
                    listener.Close();
                }
            }
        }

        throw new InvalidOperationException("Unable to bind an available localhost port.");
    }

    private static Dictionary<string, Asset> LoadAssets(string nonce)
    {
        Assembly assembly = typeof(HttpLogServer).Assembly;
        Dictionary<string, Asset> assets = new(StringComparer.Ordinal);
        foreach ((string file, string contentType) in new[]
        {
            (ViewerConstants.IndexFile, ViewerConstants.HtmlContentType),
            (ViewerConstants.StylesFile, ViewerConstants.CssContentType),
            (ViewerConstants.ScriptFile, ViewerConstants.JavaScriptContentType),
            (ViewerConstants.LicensesFile, ViewerConstants.PlainTextContentType),
        })
        {
            using Stream stream = assembly.GetManifestResourceStream(ViewerConstants.ResourcePrefix + file) ??
                throw new InvalidOperationException($"Missing embedded viewer asset: {file}.");
            using StreamReader reader = new(stream, Encoding.UTF8);
            string content = reader.ReadToEnd();
            if (file == ViewerConstants.IndexFile)
            {
                content = content.Replace(ViewerConstants.NoncePlaceholder, nonce, StringComparison.Ordinal);
            }

            assets.Add(file, new Asset(Encoding.UTF8.GetBytes(content), contentType));
        }

        return assets;
    }

    private async Task AcceptAsync()
    {
        CancellationToken cancellationToken = this.shutdown.Token;
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                HttpListenerContext context = await this.listener.GetContextAsync().WaitAsync(cancellationToken).ConfigureAwait(false);
                Task request = this.HandleAsync(context, cancellationToken);
                this.requests.TryAdd(request, 0);
                _ = request.ContinueWith(
                    completed =>
                    {
                        this.requests.TryRemove(completed, out _);
                        if (completed.IsFaulted)
                        {
                            this.diagnostics.WriteLine($"Log Studio request failed: {completed.Exception}");
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (HttpListenerException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task HandleAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        HttpListenerRequest request = context.Request;
        HttpListenerResponse response = context.Response;
        this.SetHeaders(response);
        try
        {
            if (request.RemoteEndPoint is null || !IPAddress.IsLoopback(request.RemoteEndPoint.Address) ||
                request.Url is null || request.Url.Host != ViewerConstants.LoopbackHost ||
                !request.Url.AbsolutePath.StartsWith(this.pathPrefix, StringComparison.Ordinal))
            {
                await WriteErrorAsync(response, HttpStatusCode.NotFound, NotFoundMessage, cancellationToken).ConfigureAwait(false);
                return;
            }

            string? origin = request.Headers[ViewerConstants.OriginHeader];
            if (origin is not null && !string.Equals(origin, this.authority, StringComparison.OrdinalIgnoreCase))
            {
                await WriteErrorAsync(response, HttpStatusCode.Forbidden, "Only same-origin browser requests are allowed.", cancellationToken).ConfigureAwait(false);
                return;
            }

            string route = request.Url.AbsolutePath[this.pathPrefix.Length..];
            if (route is ViewerConstants.CopilotConnectRoute or ViewerConstants.CopilotChatRoute)
            {
                if (request.HttpMethod != ViewerConstants.PostMethod)
                    await WriteErrorAsync(response, HttpStatusCode.MethodNotAllowed, "Copilot requires an explicit POST action.", cancellationToken).ConfigureAwait(false);
                else
                    await this.ChatAsync(context, route == ViewerConstants.CopilotConnectRoute, cancellationToken).ConfigureAwait(false);
                return;
            }
            if (route == ViewerConstants.ImportRoute && request.HttpMethod == ViewerConstants.PostMethod)
            {
                if (request.Headers[ViewerConstants.ClearRequestHeader] != ViewerConstants.ImportAction)
                {
                    await WriteErrorAsync(response, HttpStatusCode.Forbidden, "An explicit import action header is required.", cancellationToken).ConfigureAwait(false);
                    return;
                }
                if (request.ContentLength64 > SessionTransfer.MaximumUploadBytes)
                {
                    await WriteErrorAsync(response, HttpStatusCode.RequestEntityTooLarge, "Imports are limited to 256 MiB per file.", cancellationToken).ConfigureAwait(false);
                    return;
                }
                if (!this.historySlots.Wait(0))
                {
                    await WriteErrorAsync(response, HttpStatusCode.TooManyRequests, "Wait for current history requests before importing.", cancellationToken).ConfigureAwait(false);
                    return;
                }
                try
                {
                    SessionInfo result = await SessionTransfer.ImportAsync(request.InputStream,
                        request.QueryString[ViewerConstants.ImportFormatQuery] ?? string.Empty,
                        request.QueryString[ViewerConstants.ImportNameQuery], this.sessions, cancellationToken).ConfigureAwait(false);
                    await WriteBytesAsync(response, JsonSerializer.SerializeToUtf8Bytes(result, ViewerConstants.JsonOptions),
                        ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
                }
                catch (SessionImportException exception)
                {
                    await WriteErrorAsync(response, HttpStatusCode.BadRequest, exception.Message, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    this.diagnostics.WriteLine($"Log Studio session import failed: {exception}");
                    await WriteErrorAsync(response, HttpStatusCode.InternalServerError, "Could not save the imported session. Check available disk space and permissions.", cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    this.historySlots.Release();
                }
                return;
            }
            if (route == ViewerConstants.SessionsRoute && request.HttpMethod == ViewerConstants.PostMethod)
            {
                string? action = request.Headers[ViewerConstants.ClearRequestHeader];
                if (action is not (ViewerConstants.RenameAction or ViewerConstants.DeleteSessionAction))
                {
                    await WriteErrorAsync(response, HttpStatusCode.Forbidden, "An explicit rename or delete action is required.", cancellationToken).ConfigureAwait(false);
                    return;
                }
                string id = request.QueryString[ViewerConstants.SessionIdQuery] ?? throw new ArgumentException("Choose a saved session.");
                try
                {
                    if (action == ViewerConstants.DeleteSessionAction)
                    {
                        this.sessions.Delete(id);
                        await WriteBytesAsync(response, JsonSerializer.SerializeToUtf8Bytes(new { deleted = true }, ViewerConstants.JsonOptions),
                            ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        if (request.ContentLength64 < 1 || request.ContentLength64 > ViewerConstants.MaximumSessionActionBytes)
                            throw new ArgumentException("A session name request must contain 1–2048 bytes.");
                        JsonDocument body;
                        try
                        {
                            body = await JsonDocument.ParseAsync(request.InputStream, cancellationToken: cancellationToken).ConfigureAwait(false);
                        }
                        catch (JsonException exception)
                        {
                            throw new ArgumentException("The session name request must contain valid JSON.", exception);
                        }
                        using (body)
                        {
                            if (body.RootElement.ValueKind != JsonValueKind.Object ||
                                !body.RootElement.TryGetProperty(ViewerConstants.SessionNameProperty, out JsonElement name) || name.ValueKind != JsonValueKind.String)
                                throw new ArgumentException("A session name is required.");
                            SessionInfo renamed = this.sessions.Rename(id, name.GetString() ?? string.Empty);
                            await WriteBytesAsync(response, JsonSerializer.SerializeToUtf8Bytes(renamed, ViewerConstants.JsonOptions),
                                ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
                        }
                    }
                }
                catch (Exception exception) when (exception is UnauthorizedAccessException ||
                    (exception is IOException && exception is not (FileNotFoundException or DirectoryNotFoundException)))
                {
                    this.diagnostics.WriteLine($"Log Studio saved session action failed: {exception}");
                    await WriteErrorAsync(response, HttpStatusCode.InternalServerError, "Could not change the saved session. Check local files and permissions.", cancellationToken).ConfigureAwait(false);
                }
                return;
            }
            if (route == ViewerConstants.ClearRoute && request.HttpMethod == ViewerConstants.PostMethod)
            {
                if (request.Headers[ViewerConstants.ClearRequestHeader] != ViewerConstants.ClearRequestAction)
                {
                    await WriteErrorAsync(response, HttpStatusCode.Forbidden, "An explicit clear action header is required.", cancellationToken).ConfigureAwait(false);
                    return;
                }

                try
                {
                    string? selected = request.QueryString[ViewerConstants.SessionIdQuery];
                    LogClearResult result = string.IsNullOrEmpty(selected) || selected == this.sessions.Id ? this.clearLogs() : this.sessions.Clear(selected);
                    byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(result, ViewerConstants.JsonOptions);
                    await WriteBytesAsync(response, bytes, ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    this.diagnostics.WriteLine($"Log Studio could not delete session history: {exception}");
                    await WriteErrorAsync(response, HttpStatusCode.InternalServerError, $"Could not delete session history: {exception.Message}", cancellationToken).ConfigureAwait(false);
                }

                return;
            }

            if (request.HttpMethod != ViewerConstants.GetMethod || route == ViewerConstants.ClearRoute)
            {
                await WriteErrorAsync(response, HttpStatusCode.MethodNotAllowed, "Use GET to read history or POST with an explicit action to clear it.", cancellationToken).ConfigureAwait(false);
                return;
            }

            if (route == ViewerConstants.EventsRoute || route == ViewerConstants.UpdatesRoute)
            {
                await this.StreamAsync(context, cancellationToken, route == ViewerConstants.UpdatesRoute).ConfigureAwait(false);
            }
            else if (route == ViewerConstants.SessionsRoute)
            {
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(this.sessions.List(this.logs.GetStatus()), ViewerConstants.JsonOptions);
                await WriteBytesAsync(response, bytes, ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
            }
            else if (route == ViewerConstants.SnapshotRoute)
            {
                await this.ReadHistoryAsync(context, route, cancellationToken).ConfigureAwait(false);
            }
            else if (route == ViewerConstants.SearchRoute || route == ViewerConstants.ExportRoute || route == ViewerConstants.BundleExportRoute)
            {
                await this.ReadHistoryAsync(context, route, cancellationToken).ConfigureAwait(false);
            }
            else if (this.assets.TryGetValue(route == RootRoute ? ViewerConstants.IndexFile : route, out Asset? asset))
            {
                await WriteBytesAsync(response, asset.Bytes, asset.ContentType, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                await WriteErrorAsync(response, HttpStatusCode.NotFound, NotFoundMessage, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (HttpListenerException exception)
        {
            if (!cancellationToken.IsCancellationRequested)
            {
                this.diagnostics.WriteLine($"Log Studio connection closed: {exception.Message}");
            }
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            await WriteErrorAsync(response, HttpStatusCode.NotFound, exception.Message, cancellationToken).ConfigureAwait(false);
        }
        catch (IOException exception)
        {
            if (!cancellationToken.IsCancellationRequested)
            {
                this.diagnostics.WriteLine($"Log Studio connection closed: {exception.Message}");
            }
        }
        catch (ArgumentException exception)
        {
            await WriteErrorAsync(response, HttpStatusCode.BadRequest, exception.Message, cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException exception)
        {
            this.diagnostics.WriteLine($"Log Studio session metadata could not be read: {exception}");
            await WriteErrorAsync(response, HttpStatusCode.InternalServerError, "Saved session metadata could not be read.", cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            response.Close();
        }
    }

    private async Task ChatAsync(HttpListenerContext context, bool connect, CancellationToken cancellationToken)
    {
        HttpListenerRequest request = context.Request;
        HttpListenerResponse response = context.Response;
        if (request.Headers[ViewerConstants.ClearRequestHeader] != (connect ? ViewerConstants.CopilotConnectAction : ViewerConstants.CopilotChatAction))
        {
            await WriteErrorAsync(response, HttpStatusCode.Forbidden, "An explicit Copilot action header is required.", cancellationToken).ConfigureAwait(false);
            return;
        }
        if (!connect && (request.ContentLength64 < 1 || request.ContentLength64 > CopilotChat.MaximumRequestBytes))
        {
            await WriteErrorAsync(response, HttpStatusCode.RequestEntityTooLarge, "Chat requests must contain 1–32768 bytes with a known content length.", cancellationToken).ConfigureAwait(false);
            return;
        }
        if (!this.copilotSlot.Wait(0))
        {
            await WriteErrorAsync(response, HttpStatusCode.TooManyRequests, "A Copilot request is already running. Wait for it to finish.", cancellationToken).ConfigureAwait(false);
            return;
        }
        try
        {
            if (connect)
            {
                string version = await this.copilot.ConnectAsync(cancellationToken).ConfigureAwait(false);
                await WriteBytesAsync(response, JsonSerializer.SerializeToUtf8Bytes(new { version }, ViewerConstants.JsonOptions),
                    ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
                return;
            }
            ChatRequest chat;
            try
            {
                chat = await JsonSerializer.DeserializeAsync<ChatRequest>(request.InputStream, ViewerConstants.JsonOptions, cancellationToken).ConfigureAwait(false) ??
                    throw new ArgumentException("A chat request is required.");
            }
            catch (JsonException exception)
            {
                throw new ArgumentException("The chat request must contain valid JSON.", exception);
            }
            CopilotChat.Validate(chat);
            ChatContext snapshot;
            string? selected = request.QueryString[ViewerConstants.SessionIdQuery];
            using (LogHistoryReader history = string.IsNullOrEmpty(selected) || selected == this.sessions.Id ? this.logs.OpenHistory() : this.sessions.Open(selected))
                snapshot = CopilotChat.BuildContext(chat, history, cancellationToken);
            ChatResponse result = await this.copilot.AskAsync(snapshot, cancellationToken).ConfigureAwait(false);
            await WriteBytesAsync(response, JsonSerializer.SerializeToUtf8Bytes(result, ViewerConstants.JsonOptions),
                ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
        }
        catch (CopilotException exception)
        {
            await WriteErrorAsync(response, HttpStatusCode.ServiceUnavailable, exception.Message, cancellationToken).ConfigureAwait(false);
        }
        catch (HistoryClearedException exception)
        {
            await WriteErrorAsync(response, HttpStatusCode.Conflict, exception.Message, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            this.copilotSlot.Release();
        }
    }

    private async Task ReadHistoryAsync(HttpListenerContext context, string route, CancellationToken cancellationToken)
    {
        LogQuery query;
        try
        {
            query = LogQuery.Parse(route == ViewerConstants.BundleExportRoute ? new System.Collections.Specialized.NameValueCollection() : context.Request.QueryString);
        }
        catch (ArgumentException exception)
        {
            await WriteErrorAsync(context.Response, HttpStatusCode.BadRequest, exception.Message, cancellationToken).ConfigureAwait(false);
            return;
        }

        if (!this.historySlots.Wait(0))
        {
            await WriteErrorAsync(context.Response, HttpStatusCode.TooManyRequests, "Too many history requests. Retry after the current search or export finishes.", cancellationToken).ConfigureAwait(false);
            return;
        }

        bool started = false;
        try
        {
            string? selected = context.Request.QueryString[ViewerConstants.SessionIdQuery];
            using LogHistoryReader history = string.IsNullOrEmpty(selected) || selected == this.sessions.Id ? this.logs.OpenHistory() : this.sessions.Open(selected);
            HttpListenerResponse response = context.Response;
            if (route == ViewerConstants.SearchRoute)
            {
                LogSearchResult result = await Task.Run(() => query.Search(history, cancellationToken), cancellationToken).ConfigureAwait(false);
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(result, ViewerConstants.JsonOptions);
                started = true;
                await WriteBytesAsync(response, bytes, ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
                return;
            }

            response.SendChunked = true;
            started = true;
            if (route == ViewerConstants.BundleExportRoute)
            {
                response.ContentType = ViewerConstants.ZipContentType;
                response.Headers[ViewerConstants.ContentDispositionHeader] = $"attachment; filename=\"log-studio-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.logstudio.zip\"";
                SessionInfo information = this.sessions.Information(selected, history.Status) with { EntryCount = history.Status.RetainedCount };
                await SessionTransfer.ExportAsync(response.OutputStream, history, information, cancellationToken).ConfigureAwait(false);
            }
            else if (route == ViewerConstants.ExportRoute)
            {
                response.ContentType = ViewerConstants.JsonLinesContentType;
                response.Headers[ViewerConstants.ContentDispositionHeader] = $"attachment; filename=\"log-studio-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.jsonl\"";
                using StreamWriter writer = new(response.OutputStream, new UTF8Encoding(false), leaveOpen: true);
                int written = 0;
                foreach (LogEntry entry in history.ReadEntries(query.MinimumId >= history.Status.LastId ? history.Status.LastId + 1 : query.MinimumId + 1, query.MaximumId, cancellationToken))
                {
                    if (!query.Matches(entry)) continue;
                    await writer.WriteLineAsync(JsonSerializer.Serialize(entry, ViewerConstants.JsonOptions).AsMemory(), cancellationToken).ConfigureAwait(false);
                    if (++written % ViewerConstants.StreamBatchSize == 0) await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
                }

                await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
            else
            {
                response.ContentType = ViewerConstants.JsonContentType;
                using Utf8JsonWriter writer = new(response.OutputStream);
                writer.WriteStartObject();
                writer.WriteStartArray(ViewerConstants.EntriesProperty);
                int written = 0;
                foreach (LogEntry entry in history.ReadEntries(cancellationToken: cancellationToken))
                {
                    JsonSerializer.Serialize(writer, entry, ViewerConstants.JsonOptions);
                    if (++written % ViewerConstants.StreamBatchSize == 0) await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
                }

                writer.WriteEndArray();
                writer.WritePropertyName(ViewerConstants.StatusProperty);
                JsonSerializer.Serialize(writer, history.Status, ViewerConstants.JsonOptions);
                writer.WriteEndObject();
                await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            if (!started)
                await WriteErrorAsync(context.Response, HttpStatusCode.NotFound, "Saved session was not found.", cancellationToken).ConfigureAwait(false);
            else
                context.Response.Abort();
        }
        catch (HistoryClearedException exception)
        {
            if (!started)
                await WriteErrorAsync(context.Response, HttpStatusCode.Conflict, exception.Message, cancellationToken).ConfigureAwait(false);
            else
                context.Response.Abort();
        }
        catch (RegexMatchTimeoutException exception)
        {
            this.diagnostics.WriteLine($"Log Studio regex condition timed out: {exception.Message}");
            if (!started)
                await WriteErrorAsync(context.Response, HttpStatusCode.RequestTimeout, "A regex condition exceeded its time budget. Simplify the pattern.", cancellationToken).ConfigureAwait(false);
            else
                context.Response.Abort();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            this.diagnostics.WriteLine($"Log Studio history request failed: {exception}");
            if (!started)
                await WriteErrorAsync(context.Response, HttpStatusCode.InternalServerError, $"Could not read temporary history: {exception.Message}", cancellationToken).ConfigureAwait(false);
            else
                context.Response.Abort();
        }
        finally
        {
            this.historySlots.Release();
        }
    }

    private async Task StreamAsync(HttpListenerContext context, CancellationToken cancellationToken, bool updatesOnly)
    {
        HttpListenerResponse response = context.Response;
        string? afterValue = context.Request.QueryString[ViewerConstants.AfterQuery];
        string? lastEventId = context.Request.Headers[ViewerConstants.LastEventIdHeader];
        if (!TryReadCursor(afterValue, out long after) || !TryReadCursor(lastEventId, out long lastId))
        {
            await WriteErrorAsync(response, HttpStatusCode.BadRequest, "after and Last-Event-ID must be non-negative integers.", cancellationToken).ConfigureAwait(false);
            return;
        }

        long cursor = Math.Max(after, lastId);
        if (cursor > this.logs.GetStatus().LastId)
        {
            await WriteErrorAsync(response, HttpStatusCode.BadRequest, "The replay cursor is ahead of this session.", cancellationToken).ConfigureAwait(false);
            return;
        }

        if (!this.streamSlots.Wait(0))
        {
            response.Headers[ViewerConstants.RetryAfterHeader] = "5";
            await WriteErrorAsync(response, HttpStatusCode.TooManyRequests, "Too many live viewers. Close a tab and retry.", cancellationToken).ConfigureAwait(false);
            return;
        }

        try
        {
            response.ContentType = ViewerConstants.EventStreamContentType;
            response.SendChunked = true;
            response.KeepAlive = true;
            using StreamWriter writer = new(response.OutputStream, new UTF8Encoding(false), leaveOpen: true);
            writer.NewLine = LineEnding;
            long revision = -1;
            while (!cancellationToken.IsCancellationRequested)
            {
                LogUpdate update = this.logs.GetUpdate();
                LogBatch? batch = updatesOnly ? null : this.logs.ReadAfter(cursor);
                ViewerStatus status = batch?.Status ?? update.Status;
                if (cursor > 0 && batch?.MissedCount > 0)
                {
                    await SendEventAsync(
                        writer,
                        ViewerConstants.GapEvent,
                        new { missedCount = batch.MissedCount, firstId = batch.Status.FirstId },
                        null,
                        cancellationToken).ConfigureAwait(false);
                }

                if (status.Revision != revision)
                {
                    await SendEventAsync(writer, ViewerConstants.StatusEvent, status, null, cancellationToken).ConfigureAwait(false);
                    revision = status.Revision;
                }

                if (batch?.Entries.Length > 0)
                {
                    cursor = batch.Entries[^1].Id;
                    await SendEventAsync(writer, ViewerConstants.BatchEvent, batch.Entries, cursor, cancellationToken).ConfigureAwait(false);
                }

                await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
                if (batch?.HasMore == true)
                {
                    continue;
                }

                try
                {
                    await (batch?.Changed ?? update.Changed).WaitAsync(ViewerConstants.HeartbeatInterval, cancellationToken).ConfigureAwait(false);
                }
                catch (TimeoutException)
                {
                    await writer.WriteAsync(Heartbeat.AsMemory(), cancellationToken).ConfigureAwait(false);
                    await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            this.streamSlots.Release();
        }
    }

    private static bool TryReadCursor(string? value, out long cursor)
    {
        cursor = 0;
        return value is null || long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out cursor);
    }

    private static async Task SendEventAsync<T>(StreamWriter writer, string eventName, T value, long? id, CancellationToken cancellationToken)
    {
        if (id.HasValue)
        {
            await writer.WriteAsync($"{IdPrefix}{id.Value.ToString(CultureInfo.InvariantCulture)}{LineEnding}".AsMemory(), cancellationToken).ConfigureAwait(false);
        }

        string data = JsonSerializer.Serialize(value, ViewerConstants.JsonOptions);
        await writer.WriteAsync($"{EventPrefix}{eventName}{LineEnding}{DataPrefix}{data}{LineEnding}{LineEnding}".AsMemory(), cancellationToken).ConfigureAwait(false);
    }

    private static async Task WriteErrorAsync(HttpListenerResponse response, HttpStatusCode status, string message, CancellationToken cancellationToken)
    {
        response.StatusCode = (int)status;
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new { error = message }, ViewerConstants.JsonOptions);
        await WriteBytesAsync(response, bytes, ViewerConstants.JsonContentType, cancellationToken).ConfigureAwait(false);
    }

    private static async Task WriteBytesAsync(HttpListenerResponse response, byte[] bytes, string contentType, CancellationToken cancellationToken)
    {
        response.ContentType = contentType;
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
    }

    private void SetHeaders(HttpListenerResponse response)
    {
        response.Headers[ViewerConstants.CacheControlHeader] = ViewerConstants.NoStore;
        response.Headers[ViewerConstants.ContentSecurityPolicyHeader] = this.contentSecurityPolicy;
        response.Headers[ViewerConstants.ReferrerPolicyHeader] = ViewerConstants.NoReferrer;
        response.Headers[ViewerConstants.ContentTypeOptionsHeader] = ViewerConstants.NoSniff;
        response.Headers[ViewerConstants.FrameOptionsHeader] = ViewerConstants.DenyFrames;
    }

    private sealed record Asset(byte[] Bytes, string ContentType);
}
