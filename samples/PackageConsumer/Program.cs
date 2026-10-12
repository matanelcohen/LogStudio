using System;
using System.Threading.Tasks;
using LogStudio;

await using ConsoleLogViewer viewer = ConsoleLogViewer.Start();
Console.WriteLine("NuGet consumer: live stdout");
Console.Error.WriteLine("Error: NuGet consumer stderr");
Console.Write("NuGet consumer partial line");
await Task.Delay(600);
viewer.Complete(0);
if (viewer.GetLogs().Count != 3)
{
    throw new InvalidOperationException("The packaged library did not capture all three output entries.");
}
