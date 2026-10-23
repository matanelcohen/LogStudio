using System;
using LogStudio.Tool;

namespace LogStudio.Desktop;

internal static class DesktopOptions
{
    internal static ToolOptions Parse(string[] args)
    {
        ToolOptions options = ToolOptions.Parse([ToolOptions.ListenAllSwitch, .. args]);
        if (options.OpenBrowser)
        {
            throw new ArgumentException("The desktop app opens its own window. Use logstudio --listen-all --open for a browser.");
        }

        return options;
    }
}
