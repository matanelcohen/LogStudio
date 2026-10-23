using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace LogStudio.Desktop;

// NSApplication terminates without returning from Photino's message loop, including Cmd+Q.
[SupportedOSPlatform("macos")]
internal sealed class MacApplicationLifetime : IDisposable
{
    private const string ObjectiveC = "/usr/lib/libobjc.A.dylib";
    private static readonly ConcurrentDictionary<IntPtr, Action> Callbacks = new();
    private static readonly NotificationHandler Handler = OnTermination;
    private static readonly Lazy<IntPtr> ObserverClass = new(CreateObserverClass);
    private readonly IntPtr center;
    private IntPtr observer;

    internal MacApplicationLifetime(Action shutdown)
    {
        IntPtr type = ObserverClass.Value;
        this.center = Send(GetClass("NSNotificationCenter"), Selector("defaultCenter"));
        this.observer = Send(Send(type, Selector("alloc")), Selector("init"));
        if (this.observer == IntPtr.Zero) throw new InvalidOperationException("Could not observe macOS application shutdown.");
        Callbacks[this.observer] = shutdown;
        IntPtr name = CreateString(Send(GetClass("NSString"), Selector("alloc")), Selector("initWithUTF8String:"),
            "NSApplicationWillTerminateNotification");
        try
        {
            AddObserver(this.center, Selector("addObserver:selector:name:object:"), this.observer,
                Selector("logStudioWillTerminate:"), name, IntPtr.Zero);
        }
        finally
        {
            SendVoid(name, Selector("release"));
        }
    }

    public void Dispose()
    {
        if (this.observer == IntPtr.Zero) return;
        RemoveObserver(this.center, Selector("removeObserver:"), this.observer);
        Callbacks.TryRemove(this.observer, out _);
        SendVoid(this.observer, Selector("release"));
        this.observer = IntPtr.Zero;
    }

    private static IntPtr CreateObserverClass()
    {
        _ = NativeLibrary.Load("/System/Library/Frameworks/Foundation.framework/Foundation");
        IntPtr type = AllocateClass(GetClass("NSObject"), "LogStudioApplicationLifetime", UIntPtr.Zero);
        if (type == IntPtr.Zero || !AddMethod(type, Selector("logStudioWillTerminate:"), Handler, "v@:@"))
        {
            throw new InvalidOperationException("Could not register macOS application shutdown.");
        }
        RegisterClass(type);
        return type;
    }

    private static void OnTermination(IntPtr observer, IntPtr selector, IntPtr notification)
    {
        if (Callbacks.TryGetValue(observer, out Action? shutdown)) shutdown();
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void NotificationHandler(IntPtr observer, IntPtr selector, IntPtr notification);

    [DllImport(ObjectiveC, EntryPoint = "objc_getClass")]
    private static extern IntPtr GetClass([MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [DllImport(ObjectiveC, EntryPoint = "sel_registerName")]
    private static extern IntPtr Selector([MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [DllImport(ObjectiveC, EntryPoint = "objc_allocateClassPair")]
    private static extern IntPtr AllocateClass(IntPtr superclass, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, UIntPtr extraBytes);

    [DllImport(ObjectiveC, EntryPoint = "class_addMethod")]
    [return: MarshalAs(UnmanagedType.I1)]
    private static extern bool AddMethod(IntPtr type, IntPtr selector, NotificationHandler method,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string signature);

    [DllImport(ObjectiveC, EntryPoint = "objc_registerClassPair")]
    private static extern void RegisterClass(IntPtr type);

    [DllImport(ObjectiveC, EntryPoint = "objc_msgSend")]
    private static extern IntPtr Send(IntPtr receiver, IntPtr selector);

    [DllImport(ObjectiveC, EntryPoint = "objc_msgSend")]
    private static extern void SendVoid(IntPtr receiver, IntPtr selector);

    [DllImport(ObjectiveC, EntryPoint = "objc_msgSend")]
    private static extern IntPtr CreateString(IntPtr receiver, IntPtr selector, [MarshalAs(UnmanagedType.LPUTF8Str)] string value);

    [DllImport(ObjectiveC, EntryPoint = "objc_msgSend")]
    private static extern void AddObserver(IntPtr receiver, IntPtr selector, IntPtr observer, IntPtr callbackSelector, IntPtr name, IntPtr subject);

    [DllImport(ObjectiveC, EntryPoint = "objc_msgSend")]
    private static extern void RemoveObserver(IntPtr receiver, IntPtr selector, IntPtr observer);
}
