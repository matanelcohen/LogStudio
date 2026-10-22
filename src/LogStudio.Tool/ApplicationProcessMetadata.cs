using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LogStudio.Tool;

internal sealed record ApplicationProcessMetadata(RunningApplicationProcess Process, int ParentProcessId, bool IsLauncher, bool IsTool)
{
    private const int MaximumCommandLineBytes = 256 * 1024;
    private const int MaximumApplicationNameLength = 128;

    internal static ApplicationProcessMetadata? Read(int processId)
    {
        try
        {
            using Process process = System.Diagnostics.Process.GetProcessById(processId);
            long startedAtTicks = process.StartTime.ToUniversalTime().Ticks;
            string? executable = process.MainModule?.FileName;
            if (process.HasExited || string.IsNullOrWhiteSpace(executable) || startedAtTicks <= 0) return null;

            int parent = 0;
            string[] arguments = [];
            string? directory = null;
            try
            {
                if (OperatingSystem.IsLinux())
                {
                    string root = $"/proc/{processId.ToString(CultureInfo.InvariantCulture)}";
                    string stat = File.ReadAllText(root + "/stat");
                    string[] fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ', 3);
                    if (fields.Length >= 2) int.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out parent);
                    using FileStream stream = File.OpenRead(root + "/cmdline");
                    byte[] buffer = new byte[MaximumCommandLineBytes];
                    int count = stream.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);
                    arguments = ReadNullTerminatedArguments(buffer.AsSpan(0, count));
                    directory = Directory.ResolveLinkTarget(root + "/cwd", returnFinalTarget: true)?.FullName;
                }
                else if (OperatingSystem.IsMacOS())
                {
                    byte[] info = new byte[64]; // proc_bsdshortinfo; ppid follows pid.
                    if (ProcPidInfo(processId, 13, 0, info, info.Length) == info.Length)
                        parent = BinaryPrimitives.ReadInt32LittleEndian(info.AsSpan(4));
                    byte[] size = new byte[4];
                    nuint length = 4;
                    if (Sysctl([1, 8], 2, size, ref length, IntPtr.Zero, 0) == 0)
                    {
                        int capacity = BinaryPrimitives.ReadInt32LittleEndian(size);
                        if (capacity > 0)
                        {
                            byte[] buffer = new byte[Math.Min(capacity, MaximumCommandLineBytes)];
                            length = (nuint)buffer.Length;
                            if (Sysctl([1, 49, processId], 3, buffer, ref length, IntPtr.Zero, 0) == 0)
                                arguments = ReadMacArguments(buffer.AsSpan(0, checked((int)length)));
                        }
                    }

                    // proc_vnodepathinfo contains two vnode_info_path records (152 + MAXPATHLEN).
                    byte[] paths = new byte[2 * (152 + 1024)];
                    if (ProcPidInfo(processId, 9, 0, paths, paths.Length) == paths.Length)
                        directory = ReadNullTerminatedArguments(paths.AsSpan(152, 1024), 1) is [string cwd] ? cwd : null;
                }
                else if (OperatingSystem.IsWindows())
                {
                    if (QueryBasicInformation(process.SafeHandle, 0, out ProcessBasicInformation info,
                        Marshal.SizeOf<ProcessBasicInformation>(), out _) == 0)
                        parent = checked((int)info.ParentProcessId);
                    arguments = ReadWindowsArguments(process.SafeHandle);
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or Win32Exception)
            {
                // Missing metadata stays ungrouped rather than merging unrelated dotnet hosts.
            }

            return process.HasExited ? null : Create(processId, startedAtTicks, executable, arguments, directory, parent);
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or
            Win32Exception or IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return null;
        }
    }

    internal static ApplicationProcessMetadata Create(int processId, long startedAtTicks, string executable,
        string[] arguments, string? directory, int parentProcessId)
    {
        string name = Path.GetFileName(executable);
        if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
        string? path = executable;
        bool launcher = false;
        bool tool = false;
        if (string.Equals(name, "dotnet", StringComparison.OrdinalIgnoreCase))
        {
            path = null;
            tool = true;
            int index = 1;
            if (index < arguments.Length && arguments[index] == "exec") index++;
            while (index < arguments.Length)
            {
                string argument = arguments[index++];
                int equals = argument.IndexOf('=');
                string option = equals < 0 ? argument : argument[..equals];
                if (option is "--runtimeconfig" or "--depsfile" or "--additionalprobingpath" or "--additional-deps" or "--fx-version" or "--roll-forward")
                {
                    if (equals < 0) index++;
                    continue;
                }

                if (argument is "run" or "watch")
                {
                    launcher = true;
                    tool = false;
                    name = "dotnet " + argument;
                    path = directory;
                    for (; index < arguments.Length && arguments[index] != "--"; index++)
                    {
                        string project = arguments[index];
                        if (project is "--project" or "-p")
                        {
                            if (++index < arguments.Length) path = ResolvePath(arguments[index], directory);
                            break;
                        }
                        if (project.StartsWith("--project=", StringComparison.Ordinal))
                        {
                            path = ResolvePath(project["--project=".Length..], directory);
                            break;
                        }
                    }
                }
                else if (!argument.StartsWith('-') && argument.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                {
                    name = Path.GetFileNameWithoutExtension(argument);
                    path = ResolvePath(argument, directory);
                    tool = IsToolName(name);
                }
                else if (argument is "build" or "test" or "msbuild" or "restore" or "publish")
                {
                    name = "dotnet " + argument;
                }

                // Application arguments can contain secrets or DLL-like values; never inspect past the entrypoint.
                break;
            }
        }
        else
        {
            string assembly = executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? executable[..^4] + ".dll" : executable + ".dll";
            if (File.Exists(assembly)) path = assembly;
            tool = IsToolName(name);
        }

        name = name.Trim();
        if (name.Length > MaximumApplicationNameLength) name = name[..MaximumApplicationNameLength];
        return new(new(processId, name, startedAtTicks, path), parentProcessId, launcher, tool);
    }

    private static bool IsToolName(string name) => name is "MSBuild" or "VBCSCompiler" or "csc" or "vbc" or "dotnet-watch" or "dotnet";

    private static string? ResolvePath(string path, string? directory)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        if (Path.IsPathFullyQualified(path)) return Path.GetFullPath(path);
        return directory is null ? null : Path.GetFullPath(path, directory);
    }

    internal static string[] ReadNullTerminatedArguments(ReadOnlySpan<byte> bytes, int maximumCount = int.MaxValue)
    {
        List<string> arguments = [];
        while (!bytes.IsEmpty && arguments.Count < maximumCount)
        {
            int end = bytes.IndexOf((byte)0);
            if (end < 0) break;
            arguments.Add(Encoding.UTF8.GetString(bytes[..end]));
            bytes = bytes[(end + 1)..];
        }
        return arguments.ToArray();
    }

    internal static string[] ReadMacArguments(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 4) return [];
        int count = BinaryPrimitives.ReadInt32LittleEndian(bytes);
        if (count <= 0) return [];
        bytes = bytes[4..];
        int executableEnd = bytes.IndexOf((byte)0);
        if (executableEnd < 0) return [];
        bytes = bytes[(executableEnd + 1)..];
        while (!bytes.IsEmpty && bytes[0] == 0) bytes = bytes[1..];
        return ReadNullTerminatedArguments(bytes, count);
    }

    private static string[] ReadWindowsArguments(SafeProcessHandle process)
    {
        QueryInformation(process, 60, IntPtr.Zero, 0, out int size);
        if (size <= 0 || size > MaximumCommandLineBytes) return [];
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (QueryInformation(process, 60, buffer, size, out _) != 0) return [];
            UnicodeString value = Marshal.PtrToStructure<UnicodeString>(buffer);
            string? commandLine = Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
            if (string.IsNullOrEmpty(commandLine)) return [];
            IntPtr argv = CommandLineToArgv(commandLine, out int count);
            if (argv == IntPtr.Zero) return [];
            try
            {
                string[] arguments = new string[count];
                for (int index = 0; index < count; index++)
                    arguments[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, index * IntPtr.Size)) ?? string.Empty;
                return arguments;
            }
            finally
            {
                LocalFree(argv);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        internal IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, ProcessId, ParentProcessId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        internal ushort Length, MaximumLength;
        internal IntPtr Buffer;
    }

    [DllImport("/usr/lib/libSystem.B.dylib", EntryPoint = "sysctl", ExactSpelling = true)]
    private static extern int Sysctl(int[] name, uint nameLength, [Out] byte[] value, ref nuint length, IntPtr newValue, nuint newLength);

    [DllImport("/usr/lib/libproc.dylib", EntryPoint = "proc_pidinfo", ExactSpelling = true)]
    private static extern int ProcPidInfo(int processId, int flavor, ulong argument, [Out] byte[] buffer, int size);

    [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess", ExactSpelling = true)]
    private static extern int QueryBasicInformation(SafeProcessHandle process, int informationClass,
        out ProcessBasicInformation information, int size, out int returnLength);

    [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess", ExactSpelling = true)]
    private static extern int QueryInformation(SafeProcessHandle process, int informationClass, IntPtr information, int size, out int returnLength);

    [DllImport("shell32.dll", EntryPoint = "CommandLineToArgvW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr CommandLineToArgv(string commandLine, out int count);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
}
