using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using LogStudio;

internal static class StartupHook
{
    private const string DotnetCliAssembly = "dotnet";
    private const string MsbuildAssembly = "MSBuild";
    private const string CompilerAssembly = "VBCSCompiler";
    private const string TrueValue = "true";
    private const string FalseValue = "false";
    private const string EnabledValue = "1";
    private const string DisabledValue = "0";

    private static readonly HashSet<string> BuildToolAssemblies = new(StringComparer.OrdinalIgnoreCase)
    {
        DotnetCliAssembly,
        MsbuildAssembly,
        CompilerAssembly,
    };

    private static ConsoleLogViewer? viewer;

    public static void Initialize()
    {
        string? entryName = Assembly.GetEntryAssembly()?.GetName().Name;
        if ((entryName is not null && BuildToolAssemblies.Contains(entryName)) ||
            !ReadBoolean(ViewerConstants.EnabledEnvironmentVariable, true))
        {
            return;
        }

        AssemblyLoadContext.Default.Resolving += ResolveNameGenerator;
        viewer = ConsoleLogViewer.Start(new ConsoleLogViewerOptions
        {
            Port = ReadInteger(ViewerConstants.PortEnvironmentVariable, 0),
            Capacity = ReadInteger(ViewerConstants.CapacityEnvironmentVariable, ViewerConstants.DefaultCapacity),
            FlushEveryEntries = ReadInteger(ViewerConstants.FlushEveryEnvironmentVariable, ViewerConstants.DefaultFlushEveryEntries),
            OpenBrowser = ReadBoolean(ViewerConstants.OpenEnvironmentVariable, false),
            ApplicationName = Environment.GetEnvironmentVariable(ViewerConstants.NameEnvironmentVariable),
            CaptureTelemetry = ReadBoolean("LOG_STUDIO_TELEMETRY", false),
            MeterSources = Environment.GetEnvironmentVariable("LOG_STUDIO_METER_SOURCES") ?? "*",
            ActivitySources = Environment.GetEnvironmentVariable("LOG_STUDIO_ACTIVITY_SOURCES") ?? "*",
            TelemetryIntervalMilliseconds = ReadInteger("LOG_STUDIO_TELEMETRY_INTERVAL_MS", 1000),
            TelemetryCapacity = ReadInteger("LOG_STUDIO_TELEMETRY_CAPACITY", 2000),
        });
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
    }

    private static Assembly? ResolveNameGenerator(AssemblyLoadContext context, AssemblyName name)
    {
        if (name.Name != "RandomFriendlyNameGenerator") return null;
        using Stream? assembly = typeof(StartupHook).Assembly.GetManifestResourceStream("LogStudio.Dependencies.RandomFriendlyNameGenerator.dll");
        return assembly is null ? null : context.LoadFromStream(assembly);
    }

    private static void OnProcessExit(object? sender, EventArgs args) => viewer?.Dispose();

    private static int ReadInteger(string name, int defaultValue)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        if (value is null)
        {
            return defaultValue;
        }

        return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int result)
            ? result
            : throw new FormatException($"{name} must be an integer.");
    }

    private static bool ReadBoolean(string name, bool defaultValue)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        if (value is null)
        {
            return defaultValue;
        }

        if (value == EnabledValue || value.Equals(TrueValue, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (value == DisabledValue || value.Equals(FalseValue, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        throw new FormatException($"{name} must be true, false, 1, or 0.");
    }
}
