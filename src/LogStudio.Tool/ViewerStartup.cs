using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio.Tool;

internal static class ViewerStartup
{
    internal static async Task<ConsoleLogViewer?> StartAsync(
        ConsoleLogViewerOptions options,
        CancellationToken cancellationToken,
        Func<CancellationToken, Task<bool>>? confirmNewPort = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            return ConsoleLogViewer.Start(options);
        }
        catch (HttpListenerException exception) when (options.Port != 0 && HttpLogServer.IsAddressInUse(exception))
        {
            Console.Error.WriteLine($"Port {options.Port} is already in use. Log Studio may already be running.");
            if (confirmNewPort is null && Console.IsInputRedirected)
            {
                throw new InvalidOperationException(
                    "Cannot prompt with redirected input. Use the existing viewer's session URL, choose --port <number>, or use --port 0 to start on an available port.",
                    exception);
            }

            Console.Error.WriteLine("[A] Already running (exit without starting anything) / [N] Start on a new port (Esc cancels):");
            if (!await (confirmNewPort ?? ConfirmNewPortAsync)(cancellationToken).ConfigureAwait(false))
            {
                Console.Error.WriteLine("No new viewer or command started. If Log Studio is already running, use its printed session URL.");
                return null;
            }

            cancellationToken.ThrowIfCancellationRequested();
            options.Port = 0;
            return ConsoleLogViewer.Start(options);
        }
    }

    private static async Task<bool> ConfirmNewPortAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!Console.KeyAvailable)
            {
                await Task.Delay(50, cancellationToken).ConfigureAwait(false);
                continue;
            }

            switch (Console.ReadKey(intercept: true).Key)
            {
                case ConsoleKey.N:
                    return true;
                case ConsoleKey.A:
                case ConsoleKey.Escape:
                case ConsoleKey.Enter:
                    return false;
                default:
                    Console.Error.WriteLine("Press A to exit, N to start on a new port, or Esc to cancel.");
                    break;
            }
        }
    }
}
