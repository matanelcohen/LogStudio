using System;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Threading;

namespace LogStudio.Demo;

internal sealed class DemoTelemetry : IDisposable
{
    private readonly Meter meter = new("LogStudio.Demo.Orders");
    private int completedOrders;

    internal DemoTelemetry()
    {
        this.Requests = this.meter.CreateCounter<long>("demo.orders", "{order}", "Raw order-count additions by scenario");
        this.Errors = this.meter.CreateCounter<long>("demo.errors", "{error}", "Raw synthetic failure-count additions");
        this.Duration = this.meter.CreateHistogram<double>("demo.order.duration", "ms", "Individual checkout durations");
        this.InFlight = this.meter.CreateUpDownCounter<long>("demo.orders.in_flight", "{order}", "Raw in-flight order changes");
        this.meter.CreateObservableGauge("demo.orders.completed", () => Volatile.Read(ref this.completedOrders), "{order}",
            "Total completed synthetic orders in this demo process");
    }

    internal ActivitySource Orders { get; } = new("LogStudio.Demo.Orders");
    internal ActivitySource Inventory { get; } = new("LogStudio.Demo.Inventory");
    internal ActivitySource Payments { get; } = new("LogStudio.Demo.Payments");
    internal Counter<long> Requests { get; }
    internal Counter<long> Errors { get; }
    internal Histogram<double> Duration { get; }
    internal UpDownCounter<long> InFlight { get; }

    internal void CompleteOrder() => Interlocked.Increment(ref this.completedOrders);

    public void Dispose()
    {
        this.Orders.Dispose();
        this.Inventory.Dispose();
        this.Payments.Dispose();
        this.meter.Dispose();
    }
}
