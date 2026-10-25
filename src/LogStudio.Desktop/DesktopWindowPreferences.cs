using System;
using System.Drawing;
using System.IO;
using System.Threading;

namespace LogStudio.Desktop;

internal sealed class DesktopWindowPreferences : IDisposable
{
    private readonly object gate = new();
    private readonly AppSettingsStore store;
    private readonly TextWriter diagnostics;
    private readonly Timer timer;
    private DesktopWindowSettings? current;
    private bool initialized;
    private bool dirty;
    private bool disposed;

    internal DesktopWindowPreferences(AppSettingsStore store, TextWriter diagnostics)
    {
        this.store = store;
        this.diagnostics = diagnostics;
        try
        {
            this.current = store.Read().Window;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            diagnostics.WriteLine($"Could not restore desktop window settings: {exception.Message}");
        }
        this.timer = new Timer(_ => this.Flush(), null, Timeout.Infinite, Timeout.Infinite);
    }

    internal DesktopWindowSettings? Saved => this.current;

    internal void Initialize(Size size)
    {
        lock (this.gate)
        {
            this.current = new(size.Width, size.Height, this.current?.Maximized ?? false);
            this.initialized = true;
            this.dirty = true;
            this.timer.Change(250, Timeout.Infinite);
        }
    }

    internal void Update(Size size, bool maximized, bool minimized)
    {
        lock (this.gate)
        {
            if (!this.initialized || this.disposed || minimized || size.Width < 1 || size.Height < 1) return;
            DesktopWindowSettings next = maximized
                ? this.current! with { Maximized = true }
                : new(size.Width, size.Height, false);
            if (next == this.current) return;
            this.current = next;
            this.dirty = true;
            this.timer.Change(250, Timeout.Infinite);
        }
    }

    internal void Flush()
    {
        lock (this.gate)
        {
            if (!this.dirty || this.disposed) return;
            this.timer.Change(Timeout.Infinite, Timeout.Infinite);
            try
            {
                this.store.SaveWindow(this.current!);
                this.dirty = false;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException or ArgumentException)
            {
                this.diagnostics.WriteLine($"Could not autosave desktop window settings: {exception.Message}");
            }
        }
    }

    public void Dispose()
    {
        lock (this.gate)
        {
            this.Flush();
            this.disposed = true;
            this.timer.Dispose();
        }
    }
}
