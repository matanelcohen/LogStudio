using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;
using System.Text;
using LogStudio.Tool;
using Xunit;

namespace LogStudio.Tests;

public sealed class ApplicationGroupingTests
{
    private static readonly string Root = Path.GetFullPath("grouping-fixtures");
    private static readonly string Host = Path.Combine(Root, "dotnet");
    private static readonly string Api = Path.Combine(Root, "Api", "Api.dll");

    [Fact]
    public void SameEntrypointGroupsInstancesWithoutMergingDifferentPathsOrUnknownDotnetHosts()
    {
        RunningApplication[] groups = RunningApplicationGroups.Create([
            Managed(10, Api), Managed(11, Api),
            Managed(12, Path.Combine(Root, "Other", "Api.dll")),
            ApplicationProcessMetadata.Create(13, 13, Host, [Host, "unknown", "private.dll"], Root, 0),
            ApplicationProcessMetadata.Create(14, 14, Host, [], Root, 0),
        ]);

        Assert.Equal(4, groups.Length);
        RunningApplication app = Assert.Single(groups, group => group.Processes!.Length == 2);
        Assert.Equal("Api", app.Name);
        Assert.Equal(Api, app.Path);
        Assert.Equal(new[] { 10, 11 }, app.Processes!.Select(process => process.ProcessId));
        Assert.Equal(2, groups.Count(group => group.Path is null));
        Assert.DoesNotContain(groups, group => group.Path == Host);
    }

    [Fact]
    public void LaunchFamilyUsesActualAppNameAndIncludesDescendantsButNotOtherLaunches()
    {
        ApplicationProcessMetadata launcher = Launcher(10);
        ApplicationProcessMetadata app = Managed(11, Api, parent: 10);
        ApplicationProcessMetadata helper = Managed(12, Path.Combine(Root, "Worker.dll"), parent: 11);
        ApplicationProcessMetadata compiler = Managed(13, Path.Combine(Root, "VBCSCompiler.dll"), parent: 10);
        RunningApplication[] groups = RunningApplicationGroups.Create([
            launcher, app, helper, compiler, Launcher(20), Managed(21, Api, parent: 20), Managed(30, Api),
        ]);

        Assert.Equal(3, groups.Length);
        RunningApplication group = Assert.Single(groups, group => group.ProcessId == 10);
        Assert.Equal("Api", group.Name);
        Assert.Equal(Api, group.Path);
        Assert.Equal("launch:10:10", group.GroupId);
        Assert.Equal(new[] { 10, 11, 12, 13 }, group.Processes!.Select(process => process.ProcessId).Order());
        Assert.False(group.IsTool);
        Assert.DoesNotContain(group.Processes!, process => process.ProcessId is 20 or 21 or 30);
    }

    [Fact]
    public void WatchGroupIdentitySurvivesChildRestartsAndKeepsNestedRunInOneGroup()
    {
        ApplicationProcessMetadata watch = ApplicationProcessMetadata.Create(10, 10, Host, [Host, "watch"], Root, 0);
        ApplicationProcessMetadata run = Launcher(11, parent: 10);
        RunningApplication first = Assert.Single(RunningApplicationGroups.Create([watch, run, Managed(12, Api, parent: 11)]));
        RunningApplication second = Assert.Single(RunningApplicationGroups.Create([watch, run, Managed(13, Api, parent: 11)]));

        Assert.Equal(first.GroupId, second.GroupId);
        Assert.Equal(10, second.ProcessId);
        Assert.Equal("Api", second.Name);
        Assert.DoesNotContain(second.Processes!, process => process.ProcessId == 12);
    }

    [Fact]
    public void ReusedParentPidDoesNotPullAnOlderProcessIntoANewLaunch()
    {
        RunningApplication[] groups = RunningApplicationGroups.Create([
            ApplicationProcessMetadata.Create(10, 50, Host, [Host, "run"], Root, 0),
            Managed(11, Api, parent: 10),
        ]);
        Assert.Equal(2, groups.Length);
    }

    [Fact]
    public void ParentCyclesAreBounded()
    {
        RunningApplication[] groups = RunningApplicationGroups.Create([
            new(new(10, "A", 1, Api), 11, true, false),
            new(new(11, "B", 1, Api), 10, false, false),
        ]);
        Assert.Single(groups);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ManagedEntrypointsHandleHostOptionsAndNeverReadApplicationArguments(bool exec)
    {
        string[] arguments = new[] { Host }.Concat(exec ? new[] { "exec" } : [])
            .Concat(new[] { "--runtimeconfig", "configuration.json", "--depsfile=dependencies.json", Api, "--token", "private.dll" }).ToArray();
        ApplicationProcessMetadata process = ApplicationProcessMetadata.Create(10, 10, Host, arguments, Root, 0);
        Assert.Equal("Api", process.Process.Name);
        Assert.Equal(Api, process.Process.Path);
        Assert.False(process.IsTool);
        Assert.False(process.IsLauncher);
    }

    [Fact]
    public void RelativeEntrypointsRequireTheTargetsWorkingDirectory()
    {
        ApplicationProcessMetadata known = ApplicationProcessMetadata.Create(10, 10, Host, [Host, "Api.dll"], Root, 0);
        ApplicationProcessMetadata unknown = ApplicationProcessMetadata.Create(11, 11, Host, [Host, "Api.dll"], null, 0);
        Assert.Equal(Path.Combine(Root, "Api.dll"), known.Process.Path);
        Assert.Null(unknown.Process.Path);
        Assert.Equal("Api", unknown.Process.Name);
    }

    [Theory]
    [InlineData("--project", "Api/Api.csproj")]
    [InlineData("-p", "Api/Api.csproj")]
    [InlineData("--project=Api/Api.csproj", null)]
    public void RunProjectPathsStopBeforeApplicationArguments(string option, string? value)
    {
        string[] arguments = new[] { Host, "run", option }.Concat(value is null ? [] : new[] { value })
            .Concat(new[] { "--", "--project", "private.csproj" }).ToArray();
        ApplicationProcessMetadata process = ApplicationProcessMetadata.Create(10, 10, Host, arguments, Root, 0);
        Assert.True(process.IsLauncher);
        Assert.Equal(Path.Combine(Root, "Api", "Api.csproj"), process.Process.Path);
        Assert.Equal("dotnet run", process.Process.Name);
    }

    [Fact]
    public void LaunchersDoNotTreatApplicationArgumentsAsProjectMetadata()
    {
        ApplicationProcessMetadata process = ApplicationProcessMetadata.Create(10, 10, Host,
            [Host, "run", "--", "--project", "private.csproj"], Root, 0);
        Assert.Equal(Root, process.Process.Path);
    }

    [Fact]
    public void NamesAreCappedWithoutTruncatingTheGroupingPath()
    {
        string path = Path.Combine(Root, new string('n', 160) + ".dll");
        ApplicationProcessMetadata process = Managed(10, path);
        Assert.Equal(128, process.Process.Name.Length);
        Assert.Equal(path, process.Process.Path);
    }

    [Fact]
    public void NativeArgumentReadersPreserveSpacesAndIgnoreEnvironmentAndTruncatedArguments()
    {
        byte[] arguments = Encoding.UTF8.GetBytes("dotnet\0/path with spaces/Api.dll\0\0--token\0private\0SECRET=value\0");
        byte[] prefix = Encoding.UTF8.GetBytes("/usr/local/bin/dotnet\0\0");
        byte[] buffer = new byte[4 + prefix.Length + arguments.Length];
        BinaryPrimitives.WriteInt32LittleEndian(buffer, 5);
        prefix.CopyTo(buffer, 4);
        arguments.CopyTo(buffer, 4 + prefix.Length);
        Assert.Equal(new[] { "dotnet", "/path with spaces/Api.dll", "", "--token", "private" }, ApplicationProcessMetadata.ReadMacArguments(buffer));
        Assert.Equal(new[] { "dotnet", "Api.dll" },
            ApplicationProcessMetadata.ReadNullTerminatedArguments(Encoding.UTF8.GetBytes("dotnet\0Api.dll\0truncated")));
    }

    [Fact]
    public void EntrypointGroupOrderingDoesNotDependOnDiscoveryOrder()
    {
        ApplicationProcessMetadata[] processes = [Managed(11, Api, parent: 10), Managed(12, Api), Managed(10, Api)];
        RunningApplication first = Assert.Single(RunningApplicationGroups.Create(processes));
        RunningApplication second = Assert.Single(RunningApplicationGroups.Create(processes.Reverse()));
        Assert.Equal(10, first.ProcessId);
        Assert.Equal(first.ProcessId, second.ProcessId);
        Assert.Equal(first.Processes, second.Processes);
    }

    [Theory]
    [InlineData("Example.App", "Example.App")]
    [InlineData("Example.App.exe", "Example.App")]
    public void NativeApphostNamesPreserveDots(string executable, string expected)
    {
        string path = Path.Combine(Root, executable);
        ApplicationProcessMetadata process = ApplicationProcessMetadata.Create(10, 10, path, [path], Root, 0);
        Assert.Equal(expected, process.Process.Name);
        Assert.Equal(path, process.Process.Path);
        Assert.False(process.IsTool);
    }

    [Fact]
    public void NativeMetadataCanIdentifyTheCurrentManagedProcess()
    {
        ApplicationProcessMetadata? metadata = ApplicationProcessMetadata.Read(Environment.ProcessId);
        Assert.NotNull(metadata);
        Assert.Equal(Environment.ProcessId, metadata.Process.ProcessId);
        Assert.True(metadata.Process.StartedAtTicks > 0);
        Assert.True(metadata.ParentProcessId > 0);
        Assert.NotEqual("dotnet", metadata.Process.Name);
        Assert.NotNull(metadata.Process.Path);
        Assert.True(Path.IsPathFullyQualified(metadata.Process.Path));
    }

    private static ApplicationProcessMetadata Managed(int id, string path, int parent = 0) =>
        ApplicationProcessMetadata.Create(id, id, Host, [Host, path], Root, parent);

    private static ApplicationProcessMetadata Launcher(int id, int parent = 0) =>
        ApplicationProcessMetadata.Create(id, id, Host, [Host, "run"], Root, parent);
}
