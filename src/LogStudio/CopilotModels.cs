using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed record CopilotModel(string Id, string Name, string[] ReasoningEfforts);

internal static class CopilotModels
{
    internal static async Task<CopilotModel[]> DiscoverAsync(ProcessStartInfo start, CancellationToken cancellationToken)
    {
        start.ArgumentList.Clear();
        foreach (string argument in new[] { "--headless", "--stdio", "--no-auto-update", "--no-custom-instructions", "--disable-builtin-mcps", "--no-remote" })
            start.ArgumentList.Add(argument);
        string directory = Directory.CreateTempSubdirectory("logstudio-copilot-models-").FullName;
        try
        {
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            start.WorkingDirectory = Path.Combine(directory, "work");
            Directory.CreateDirectory(start.WorkingDirectory);
            CopilotCliClient.PrepareEnvironment(start, directory);
            using Process process = new() { StartInfo = start };
            if (!process.Start()) throw new CopilotException("Could not start the local Copilot CLI.");
            using CancellationTokenSource stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            Task<string> error = CopilotCliClient.ReadBoundedAsync(process.StandardError, stop.Token);
            Task<CopilotModel[]> discovery = ReadModelsAsync(process.StandardOutput.BaseStream, process.StandardInput.BaseStream, stop.Token);
            try
            {
                Task completed = await Task.WhenAny(discovery, error).ConfigureAwait(false);
                if (completed == error)
                {
                    await error.ConfigureAwait(false);
                    throw new CopilotException("Copilot model discovery failed. Update the Copilot CLI and run copilot login in a terminal.");
                }
                return await discovery.ConfigureAwait(false);
            }
            finally
            {
                stop.Cancel();
                process.StandardInput.Close();
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) { }
                await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
                try { await Task.WhenAll(error, discovery).ConfigureAwait(false); }
                catch (Exception exception) when (exception is OperationCanceledException or CopilotException or IOException or JsonException or InvalidOperationException) { }
            }
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    internal static async Task<CopilotModel[]> ReadModelsAsync(Stream input, Stream output, CancellationToken cancellationToken)
    {
        JsonElement connected = await RequestAsync(input, output, 1, "connect", cancellationToken).ConfigureAwait(false);
        if (connected.TryGetProperty("error", out JsonElement error) &&
            ((error.TryGetProperty("code", out JsonElement code) && code.GetInt32() == -32601) ||
             (error.TryGetProperty("message", out JsonElement message) && message.GetString() == "Unhandled method connect")))
            connected = await RequestAsync(input, output, 2, "ping", cancellationToken).ConfigureAwait(false);
        if (!connected.TryGetProperty("result", out JsonElement handshake) ||
            !handshake.TryGetProperty("protocolVersion", out JsonElement version) || !version.TryGetInt32(out int protocol) || protocol is < 2 or > 3)
            throw new JsonException("Copilot protocol handshake failed.");
        JsonElement response = await RequestAsync(input, output, 3, "models.list", cancellationToken).ConfigureAwait(false);
        if (!response.TryGetProperty("result", out JsonElement result) || !result.TryGetProperty("models", out JsonElement models) ||
            models.ValueKind != JsonValueKind.Array || models.GetArrayLength() > 256)
            throw new JsonException("Copilot returned an invalid model catalog.");
        List<CopilotModel> available = new();
        foreach (JsonElement model in models.EnumerateArray())
        {
            if (model.TryGetProperty("policy", out JsonElement policy) && policy.ValueKind == JsonValueKind.Object &&
                policy.TryGetProperty("state", out JsonElement state) && state.GetString() != "enabled") continue;
            string? id = model.GetProperty("id").GetString();
            string? name = model.GetProperty("name").GetString();
            if (id is null || !Regex.IsMatch(id, @"\A[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}\z", RegexOptions.CultureInvariant) ||
                string.IsNullOrWhiteSpace(name) || name.Length > 256) continue;
            bool reasoning = model.TryGetProperty("capabilities", out JsonElement capabilities) &&
                capabilities.TryGetProperty("supports", out JsonElement supports) &&
                supports.TryGetProperty("reasoningEffort", out JsonElement supported) && supported.ValueKind == JsonValueKind.True;
            string[] efforts = reasoning && model.TryGetProperty("supportedReasoningEfforts", out JsonElement levels) && levels.ValueKind == JsonValueKind.Array ?
                levels.EnumerateArray().Where(level => level.ValueKind == JsonValueKind.String).Select(level => level.GetString()!)
                    .Where(level => Regex.IsMatch(level, @"\A[a-z][a-z0-9-]{0,31}\z", RegexOptions.CultureInvariant)).Distinct(StringComparer.Ordinal).Take(16).ToArray() :
                Array.Empty<string>();
            if (available.All(candidate => candidate.Id != id)) available.Add(new CopilotModel(id, name, efforts));
        }
        return available.ToArray();
    }

    private static async Task<JsonElement> RequestAsync(Stream input, Stream output, int id, string method, CancellationToken cancellationToken)
    {
        byte[] request = JsonSerializer.SerializeToUtf8Bytes(new { jsonrpc = "2.0", id, method, @params = new { } });
        await output.WriteAsync(Encoding.ASCII.GetBytes($"Content-Length: {request.Length.ToString(CultureInfo.InvariantCulture)}\r\n\r\n"), cancellationToken).ConfigureAwait(false);
        await output.WriteAsync(request, cancellationToken).ConfigureAwait(false);
        await output.FlushAsync(cancellationToken).ConfigureAwait(false);
        for (int notification = 0; notification < 64; notification++)
        {
            StringBuilder header = new();
            byte[] next = new byte[1];
            while (!header.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
            {
                await input.ReadExactlyAsync(next, cancellationToken).ConfigureAwait(false);
                header.Append((char)next[0]);
                if (header.Length > 4096) throw new JsonException("Copilot protocol header is too large.");
            }
            string? lengthHeader = header.ToString().Split("\r\n", StringSplitOptions.RemoveEmptyEntries)
                .SingleOrDefault(line => line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
            if (lengthHeader is null || !int.TryParse(lengthHeader["Content-Length:".Length..].Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out int length) ||
                length < 1 || length > 1_048_576) throw new JsonException("Invalid Copilot protocol frame length.");
            byte[] payload = new byte[length];
            await input.ReadExactlyAsync(payload, cancellationToken).ConfigureAwait(false);
            using JsonDocument document = JsonDocument.Parse(payload);
            JsonElement message = document.RootElement;
            if (message.TryGetProperty("id", out JsonElement responseId) && responseId.ValueKind == JsonValueKind.Number && responseId.GetInt32() == id)
                return message.Clone();
        }
        throw new JsonException("Copilot did not return model metadata.");
    }
}
