using System;
using System.Collections.Generic;
using System.Globalization;

namespace LogStudio.Tool;

internal sealed record ToolOptions(int Port, int Capacity, int FlushEveryEntries, string? Name, bool OpenBrowser, bool WaitAfterExit, bool Help, bool Version, string Command, string[] Arguments, bool ListenAll = false)
{
    internal const int DefaultPort = 5177;
    internal const string CommandName = "logstudio";
    internal const string Separator = "--";
    internal const string HelpSwitch = "--help";
    internal const string ShortHelpSwitch = "-h";
    internal const string VersionSwitch = "--version";
    internal const string PortSwitch = "--port";
    internal const string CapacitySwitch = "--capacity";
    internal const string FlushEverySwitch = "--flush-every";
    internal const string NameSwitch = "--name";
    internal const string OpenSwitch = "--open";
    internal const string NoWaitSwitch = "--no-wait";
    internal const string ListenAllSwitch = "--listen-all";
    internal const string SessionsDirectoryEnvironmentVariable = "LOG_STUDIO_SESSIONS_DIRECTORY";

    internal static ToolOptions Parse(string[] args)
    {
        int port = DefaultPort;
        ConsoleLogViewerOptions defaults = new();
        int capacity = defaults.Capacity;
        int flushEvery = defaults.FlushEveryEntries;
        string? name = null;
        bool open = false;
        bool wait = true;
        bool listenAll = false;
        int index = 0;
        while (index < args.Length && args[index] != Separator)
        {
            string option = args[index++];
            switch (option)
            {
                case HelpSwitch:
                case ShortHelpSwitch:
                    return new ToolOptions(port, capacity, flushEvery, name, open, wait, true, false, string.Empty, Array.Empty<string>());
                case VersionSwitch:
                    return new ToolOptions(port, capacity, flushEvery, name, open, wait, false, true, string.Empty, Array.Empty<string>());
                case OpenSwitch:
                    open = true;
                    break;
                case NoWaitSwitch:
                    wait = false;
                    break;
                case ListenAllSwitch:
                    listenAll = true;
                    break;
                case PortSwitch:
                    port = ReadInteger(args, ref index, option);
                    break;
                case CapacitySwitch:
                    capacity = ReadInteger(args, ref index, option);
                    break;
                case FlushEverySwitch:
                    flushEvery = ReadInteger(args, ref index, option);
                    break;
                case NameSwitch:
                    name = ReadValue(args, ref index, option);
                    break;
                default:
                    throw new ArgumentException($"Unknown option '{option}'. Put the child command after {Separator}.");
            }
        }

        if (listenAll)
        {
            if (!wait)
            {
                throw new ArgumentException($"{ListenAllSwitch} cannot be combined with {NoWaitSwitch}.");
            }

            if (index < args.Length)
            {
                throw new ArgumentException($"{ListenAllSwitch} does not accept a child command or {Separator}.");
            }

            return new ToolOptions(port, capacity, flushEvery, name, open, wait, false, false, string.Empty, Array.Empty<string>(), ListenAll: true);
        }

        if (index == args.Length || ++index == args.Length)
        {
            throw new ArgumentException($"A child command is required. Usage: {CommandName} [options] {Separator} <command> [arguments]");
        }

        string command = args[index++];
        if (string.IsNullOrWhiteSpace(command))
        {
            throw new ArgumentException("The child command must not be empty.");
        }

        List<string> arguments = new();
        while (index < args.Length)
        {
            arguments.Add(args[index++]);
        }

        return new ToolOptions(port, capacity, flushEvery, name, open, wait, false, false, command, arguments.ToArray());
    }

    private static int ReadInteger(string[] args, ref int index, string option)
    {
        string value = ReadValue(args, ref index, option);
        return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int result)
            ? result
            : throw new ArgumentException($"{option} requires an integer.");
    }

    private static string ReadValue(string[] args, ref int index, string option)
    {
        if (index >= args.Length || args[index] == Separator || args[index].StartsWith(Separator, StringComparison.Ordinal))
        {
            throw new ArgumentException($"{option} requires a value.");
        }

        return args[index++];
    }
}
