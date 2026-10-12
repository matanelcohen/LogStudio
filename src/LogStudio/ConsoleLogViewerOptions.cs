using System;
using System.IO;

namespace LogStudio;

/// <summary>Options for a local, temporary-disk-backed console log viewer.</summary>
public sealed class ConsoleLogViewerOptions
{
    private const string ApplicationDirectoryName = "LogStudio";
    private const string SessionsDirectoryName = "sessions";
    /// <summary>Gets or sets the localhost port. Zero selects an available port.</summary>
    public int Port { get; set; }

    /// <summary>Gets or sets the retention limit. Zero (the default) keeps all entries for the run.</summary>
    /// <remarks>Positive values limit visible history. The temporary journal grows with log volume.</remarks>
    public int Capacity { get; set; } = ViewerConstants.DefaultCapacity;

    /// <summary>Gets or sets the number of entries between buffered journal flushes. Defaults to 1,000.</summary>
    /// <remarks>Reads, completion and shutdown also flush pending data. I/O buffer sizes do not grow with this value.</remarks>
    public int FlushEveryEntries { get; set; } = ViewerConstants.DefaultFlushEveryEntries;

    /// <summary>Gets or sets the line chunk limit. Longer output is split, not discarded.</summary>
    public int MaxLineLength { get; set; } = ViewerConstants.DefaultMaxLineLength;

    /// <summary>Gets or sets whether to tee Console.Out and Console.Error at startup.</summary>
    public bool CaptureConsole { get; set; } = true;

    /// <summary>Gets or sets whether to open the browser automatically.</summary>
    public bool OpenBrowser { get; set; }

    /// <summary>Gets or sets the session display name. Null generates a unique random name at startup.</summary>
    public string? ApplicationName { get; set; }

    /// <summary>Gets or sets whether the wrapper should retain this run for the session manager.</summary>
    public bool SaveSession { get; set; }

    /// <summary>Gets or sets the private saved-session directory. Null uses local application data.</summary>
    public string? SessionsDirectory { get; set; }

    /// <summary>Gets or sets the wrapped executable name recorded in session details.</summary>
    public string? RunCommand { get; set; }

    /// <summary>Gets or sets the command arguments. Common secret flags are redacted before saving.</summary>
    public string[] RunArguments { get; set; } = Array.Empty<string>();

    /// <summary>Gets or sets the run working directory recorded in session details.</summary>
    public string? RunWorkingDirectory { get; set; }

    internal ViewerSettings Validate()
    {
        if (this.Port < 0 || this.Port > ViewerConstants.MaximumPort)
        {
            throw new ArgumentOutOfRangeException(nameof(this.Port), "Port must be between 0 and 65535.");
        }

        if (this.Capacity < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(this.Capacity), "Capacity must be non-negative. Zero keeps all entries.");
        }

        if (this.FlushEveryEntries < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(this.FlushEveryEntries), "FlushEveryEntries must be positive.");
        }

        if (this.MaxLineLength < ViewerConstants.MinimumMaxLineLength ||
            this.MaxLineLength > ViewerConstants.MaximumMaxLineLength)
        {
            throw new ArgumentOutOfRangeException(nameof(this.MaxLineLength), "MaxLineLength must be between 64 and 65536.");
        }

        string name = this.ApplicationName ?? SessionCatalog.GenerateName();
        if (string.IsNullOrWhiteSpace(name) || name.Length > ViewerConstants.MaximumApplicationNameLength)
        {
            throw new ArgumentException("ApplicationName must contain between 1 and 128 characters.", nameof(this.ApplicationName));
        }

        ArgumentNullException.ThrowIfNull(this.RunArguments);
        string sessions = this.SessionsDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), ApplicationDirectoryName, SessionsDirectoryName);
        if (string.IsNullOrWhiteSpace(sessions)) throw new ArgumentException("SessionsDirectory must not be empty.");
        return new ViewerSettings(this.Port, this.Capacity, this.FlushEveryEntries, this.MaxLineLength, this.CaptureConsole, this.OpenBrowser, name,
            this.SaveSession, Path.GetFullPath(sessions), this.RunCommand, (string[])this.RunArguments.Clone(), this.RunWorkingDirectory ?? Environment.CurrentDirectory);
    }
}

internal sealed record ViewerSettings(
    int Port,
    int Capacity,
    int FlushEveryEntries,
    int MaxLineLength,
    bool CaptureConsole,
    bool OpenBrowser,
    string ApplicationName,
    bool SaveSession,
    string SessionsDirectory,
    string? RunCommand,
    string[] RunArguments,
    string RunWorkingDirectory);
