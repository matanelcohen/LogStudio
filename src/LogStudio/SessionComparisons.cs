using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed class SessionComparisons : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, Job> jobs = new(StringComparer.Ordinal);
    private readonly ComparisonLimits limits;
    private readonly CancellationToken shutdown;
    private readonly Timer expiry;
    private bool disposed;

    internal SessionComparisons(CancellationToken shutdown, ComparisonLimits? limits = null)
    {
        this.shutdown = shutdown;
        this.limits = limits ?? new();
        if (this.limits.ChunkRows < 1 || this.limits.ChunkBytes < 1 || this.limits.MergeFanIn < 2 ||
            this.limits.MaximumJobs < 1 || this.limits.MaximumWorkers < 1)
            throw new ArgumentException("Comparison limits must be positive and merge fan-in must be at least two.");
        this.expiry = new Timer(_ => this.Sweep(DateTimeOffset.UtcNow), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    internal ComparisonSnapshot Start(SessionCatalog catalog, ComparisonRequest request)
    {
        if (request.Grouping is not ("normalized" or "raw") || request.FilterScope is not ("all" or "saved") ||
            string.IsNullOrEmpty(request.BaselineId) || string.IsNullOrEmpty(request.CandidateId) ||
            request.BaselineId == request.CandidateId)
            throw new ArgumentException("Choose two distinct completed sessions, grouping normalized or raw, and filterScope all or saved.");
        lock (this.gate)
        {
            ObjectDisposedException.ThrowIf(this.disposed, this);
            this.Sweep(DateTimeOffset.UtcNow);
            foreach (Job old in this.jobs.Values.Where(job => job.Released).ToArray())
            {
                this.jobs.Remove(old.Id);
                old.Dispose();
            }
            if (this.jobs.Count >= this.limits.MaximumJobs ||
                this.jobs.Values.Count(job => !job.WorkerDone) >= this.limits.MaximumWorkers)
                throw new ComparisonCapacityException("Comparison capacity reached. Cancel an existing comparison or wait for it to finish.");
            ComparisonSource baseline = catalog.CaptureComparison(request.BaselineId);
            ComparisonSource candidate = catalog.CaptureComparison(request.CandidateId);
            Job job = new(catalog, baseline, candidate, request, this.limits, this.shutdown);
            this.jobs.Add(job.Id, job);
            job.Start();
            return job.Snapshot();
        }
    }

    internal ComparisonSnapshot Snapshot(string id) => this.Find(id).Snapshot();
    internal ComparisonSnapshot Cancel(string id)
    {
        Job job = this.Find(id);
        job.Stop("cancelled");
        return job.Snapshot();
    }

    internal ComparisonGroups Groups(string id, string kind, string change, long offset, CancellationToken cancellationToken)
    {
        if (kind is not ("severity" or "category" or "message") ||
            change is not ("all" or "new" or "resolved" or "changed" or "unchanged") || offset < 0)
            throw new ArgumentException("Choose a supported kind and change, and a non-negative offset.");
        return this.Find(id).Groups(kind, change, offset, cancellationToken);
    }

    internal ComparisonEvidence Evidence(string id, string groupId, string side, long after, CancellationToken cancellationToken)
    {
        if (side is not ("baseline" or "candidate") || after < 0)
            throw new ArgumentException("side must be baseline or candidate and after must be non-negative.");
        return this.Find(id).Evidence(groupId, side == "baseline", after, cancellationToken);
    }

    internal Task WaitForCompletionAsync(string id) => this.Find(id).Worker;

    internal void Sweep(DateTimeOffset now)
    {
        lock (this.gate)
        {
            foreach (Job job in this.jobs.Values)
            {
                if (now - job.CreatedAt >= (this.limits.Lifetime ?? TimeSpan.FromMinutes(15))) job.Stop("cancelled", "Comparison expired.");
                job.Cleanup();
            }
        }
    }

    private Job Find(string id)
    {
        lock (this.gate)
        {
            if (id is null || !this.jobs.TryGetValue(id, out Job? job))
                throw new FileNotFoundException("The comparison does not exist or has expired.");
            return job;
        }
    }

    public async ValueTask DisposeAsync()
    {
        Job[] remaining;
        lock (this.gate)
        {
            this.disposed = true;
            remaining = this.jobs.Values.ToArray();
        }
        await this.expiry.DisposeAsync().ConfigureAwait(false);
        foreach (Job job in remaining) job.Stop("cancelled");
        await Task.WhenAll(remaining.Select(job => job.Worker)).ConfigureAwait(false);
        foreach (Job job in remaining)
        {
            job.Cleanup();
            job.Dispose();
        }
    }

    private sealed class Job : IDisposable
    {
        private readonly object gate = new();
        private readonly SessionCatalog catalog;
        private readonly ComparisonSource baseline;
        private readonly ComparisonSource candidate;
        private readonly LogQuery baselineQuery;
        private readonly LogQuery candidateQuery;
        private readonly ComparisonLimits limits;
        private readonly CancellationTokenSource cancellation;
        private readonly CancellationToken token;
        private ComparisonSnapshot snapshot;
        private string? directory;
        private int readers;
        private bool workerDone;
        private bool cleanupInProgress;
        private long baselineProcessed;
        private long candidateProcessed;

        internal Job(SessionCatalog catalog, ComparisonSource baseline, ComparisonSource candidate,
            ComparisonRequest request, ComparisonLimits limits, CancellationToken shutdown)
        {
            this.catalog = catalog;
            this.baseline = baseline;
            this.candidate = candidate;
            this.limits = limits;
            this.Id = Guid.NewGuid().ToString("N");
            ComparisonSide left = Side(baseline, request.FilterScope);
            ComparisonSide right = Side(candidate, request.FilterScope);
            this.baselineQuery = left.Filters?.ToQuery() ?? LogQuery.Parse(new NameValueCollection());
            this.candidateQuery = right.Filters?.ToQuery() ?? LogQuery.Parse(new NameValueCollection());
            this.snapshot = new(this.Id, "running", "queued", 0, checked(baseline.ExpectedEntries + candidate.ExpectedEntries),
                null, left, right, request.Grouping, request.Grouping == "raw" ? "Raw: exact ordinal message text; severity and category remain part of the key." : ComparisonSignatures.Rule);
            this.cancellation = CancellationTokenSource.CreateLinkedTokenSource(shutdown);
            this.token = this.cancellation.Token;
            try
            {
                this.directory = catalog.CreateComparisonStorage(this.Id);
                SessionCatalog.HistoryInvalidated += this.OnHistoryInvalidated;
            }
            catch
            {
                this.cancellation.Dispose();
                throw;
            }
        }

        internal string Id { get; }
        internal DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
        internal Task Worker { get; private set; } = Task.CompletedTask;
        internal bool WorkerDone { get { lock (this.gate) return this.workerDone; } }
        internal bool Released { get { lock (this.gate) return this.workerDone && this.readers == 0 && this.directory is null && !this.cleanupInProgress; } }

        internal void Start() => this.Worker = Task.Run(this.Run);

        internal ComparisonSnapshot Snapshot()
        {
            this.CheckGeneration();
            lock (this.gate)
                return this.snapshot with { Baseline = Copy(this.snapshot.Baseline), Candidate = Copy(this.snapshot.Candidate) };
        }

        private static ComparisonSide Copy(ComparisonSide side) => side with
        {
            Session = side.Session with { Arguments = (string[])side.Session.Arguments.Clone(), Filters = side.Session.Filters?.Snapshot() },
            Filters = side.Filters?.Snapshot(),
        };

        private static ComparisonSide Side(ComparisonSource source, string filterScope)
        {
            SessionFilters? filters = filterScope == "saved" ? source.Session.Filters?.Snapshot() : null;
            if (filters is not null)
            {
                filters.Validate();
                if (filters.TimeWindow != 0)
                {
                    DateTimeOffset end = source.Session.CompletedAt!.Value;
                    filters = filters with
                    {
                        Since = end.AddMilliseconds(-filters.TimeWindow).ToString("O", CultureInfo.InvariantCulture),
                        Until = end.ToString("O", CultureInfo.InvariantCulture),
                        TimeWindow = 0,
                    };
                }
                filters.Validate();
            }
            return new(source.Session, filters, 0, source.ExpectedEntries, (source.Session.CompletedAt!.Value - source.Session.StartedAt).TotalMilliseconds);
        }

        private void OnHistoryInvalidated(string storageDirectory, string id)
        {
            StringComparison comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (string.Equals(storageDirectory, this.catalog.StorageDirectory, comparison) &&
                (id == this.baseline.Session.Id || id == this.candidate.Session.Id))
                this.Stop("invalidated", "A compared session was cleared or deleted.");
        }

        private void CheckGeneration()
        {
            if (!this.catalog.IsComparisonCurrent(this.baseline) || !this.catalog.IsComparisonCurrent(this.candidate))
                this.Stop("invalidated", "A compared session was cleared or deleted.");
        }

        internal void Stop(string state, string? error = null)
        {
            lock (this.gate)
            {
                if (this.snapshot.State is "running" or "completed")
                {
                    this.snapshot = this.snapshot with { State = state, Phase = state, Error = error };
                    this.cancellation.Cancel();
                }
            }
            this.Cleanup();
        }

        private void Run()
        {
            using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(this.token);
            deadline.CancelAfter(this.limits.Timeout ?? TimeSpan.FromMinutes(5));
            CancellationToken work = deadline.Token;
            try
            {
                this.CheckGeneration();
                work.ThrowIfCancellationRequested();
                using ComparisonSort sort = new(this.directory!, this.limits, work);
                this.Scan(this.baseline, this.baselineQuery, true, sort, work);
                this.Scan(this.candidate, this.candidateQuery, false, sort, work);
                lock (this.gate)
                    if (this.snapshot.State == "running") this.snapshot = this.snapshot with { Phase = "sorting" };
                sort.Finish();
                this.CheckGeneration();
                work.ThrowIfCancellationRequested();
                lock (this.gate)
                {
                    if (this.snapshot.State == "running")
                        this.snapshot = this.snapshot with { State = "completed", Phase = "completed" };
                }
            }
            catch (OperationCanceledException)
            {
                this.CheckGeneration();
                this.Stop(this.token.IsCancellationRequested ? "cancelled" : "failed",
                    this.token.IsCancellationRequested ? null : "Comparison exceeded its five-minute work deadline. Narrow the saved filters and retry.");
            }
            catch (HistoryClearedException)
            {
                this.Stop("invalidated", "A compared session was cleared or deleted.");
            }
            catch (Exception exception)
            {
                this.CheckGeneration();
                this.Stop("failed", "Comparison failed; no partial results are available. " + exception.Message);
            }
            finally
            {
                lock (this.gate) this.workerDone = true;
                this.Cleanup();
            }
        }

        private void Scan(ComparisonSource source, LogQuery query, bool isBaseline, ComparisonSort sort, CancellationToken work)
        {
            long observed = 0;
            long matched = 0;
            lock (this.gate)
                if (this.snapshot.State == "running") this.snapshot = this.snapshot with { Phase = isBaseline ? "scanning baseline" : "scanning candidate" };
            using LogHistoryReader history = this.catalog.OpenComparison(source);
            foreach (LogEntry entry in history.ReadSessionEntries(work, SessionTransfer.MaximumJsonLineCharacters))
            {
                work.ThrowIfCancellationRequested();
                observed++;
                if (query.Matches(entry))
                {
                    matched++;
                    sort.Add(entry, isBaseline, this.snapshot.Grouping);
                }
                if (observed % 128 == 0) this.Progress(isBaseline, observed, matched);
            }
            history.EnsureCompleteSessionRead();
            if (observed != source.ExpectedEntries)
                throw new InvalidDataException("The observed journal count does not match the captured session; no partial results are available.");
            this.Progress(isBaseline, observed, matched);
        }

        private void Progress(bool isBaseline, long observed, long matched)
        {
            this.CheckGeneration();
            lock (this.gate)
            {
                ComparisonSide side = (isBaseline ? this.snapshot.Baseline : this.snapshot.Candidate) with { MatchedCount = matched };
                if (isBaseline) this.baselineProcessed = observed;
                else this.candidateProcessed = observed;
                this.snapshot = isBaseline ? this.snapshot with { Baseline = side } : this.snapshot with { Candidate = side };
                this.snapshot = this.snapshot with { ProcessedEntries = checked(this.baselineProcessed + this.candidateProcessed) };
            }
        }

        private (string Directory, CancellationTokenSource Cancellation) BeginRead(CancellationToken request)
        {
            this.CheckGeneration();
            lock (this.gate)
            {
                if (this.snapshot.State != "completed") throw new ComparisonUnavailableException("Comparison results are unavailable: " + this.snapshot.State + ".");
                CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(request, this.token);
                this.readers++;
                return (this.directory!, linked);
            }
        }

        private void EndRead()
        {
            lock (this.gate) this.readers--;
            this.Cleanup();
        }

        private void EnsureRead(CancellationToken cancellationToken)
        {
            this.CheckGeneration();
            lock (this.gate)
                if (this.snapshot.State != "completed")
                    throw new ComparisonUnavailableException("Comparison results are unavailable: " + this.snapshot.State + ".");
            cancellationToken.ThrowIfCancellationRequested();
        }

        internal ComparisonGroups Groups(string kind, string change, long offset, CancellationToken request)
        {
            (string path, CancellationTokenSource linked) = this.BeginRead(request);
            using (linked)
            try
            {
                List<ComparisonGroup> page = new(50);
                long total = 0;
                using StreamReader reader = File.OpenText(Path.Combine(path, "groups.jsonl"));
                string? line;
                while ((line = reader.ReadLine()) is not null)
                {
                    linked.Token.ThrowIfCancellationRequested();
                    ComparisonGroup group = JsonSerializer.Deserialize<ComparisonGroup>(line, ViewerConstants.JsonOptions)!;
                    if (group.Kind != kind || (change != "all" && group.Change != change)) continue;
                    if (total++ >= offset && page.Count < 50) page.Add(group);
                }
                this.EnsureRead(linked.Token);
                return new(page.ToArray(), total, offset);
            }
            catch (OperationCanceledException) when (!request.IsCancellationRequested)
            {
                throw new ComparisonUnavailableException("Comparison results were cancelled or invalidated.");
            }
            finally { this.EndRead(); }
        }

        internal ComparisonEvidence Evidence(string groupId, bool isBaseline, long after, CancellationToken request)
        {
            (string path, CancellationTokenSource linked) = this.BeginRead(request);
            using (linked)
            try
            {
                ComparisonGroup group = ReadGroup(path, groupId);
                ComparisonSource source = isBaseline ? this.baseline : this.candidate;
                LogQuery query = isBaseline ? this.baselineQuery : this.candidateQuery;
                List<LogEntry> page = new(50);
                long? nextAfter = null;
                using LogHistoryReader history = this.catalog.OpenComparison(source);
                foreach (LogEntry entry in history.ReadSessionEntries(linked.Token, SessionTransfer.MaximumJsonLineCharacters))
                {
                    if (entry.Id <= after || !query.Matches(entry) || !ComparisonKey.For(entry, group.Kind, this.snapshot.Grouping).Matches(group)) continue;
                    if (page.Count == 50)
                    {
                        nextAfter = page[^1].Id;
                        break;
                    }
                    page.Add(entry);
                }
                this.EnsureRead(linked.Token);
                return new(source.Session.Id, page.ToArray(), nextAfter);
            }
            catch (HistoryClearedException)
            {
                this.Stop("invalidated", "A compared session was cleared or deleted.");
                throw new ComparisonUnavailableException("A compared session was cleared or deleted.");
            }
            catch (OperationCanceledException) when (!request.IsCancellationRequested)
            {
                throw new ComparisonUnavailableException("Comparison results were cancelled or invalidated.");
            }
            finally { this.EndRead(); }
        }

        private static ComparisonGroup ReadGroup(string directory, string id)
        {
            if (id is null || id.Length < 2 || id[0] != 'g' ||
                !long.TryParse(id.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out long ordinal) || ordinal < 1)
                throw new ArgumentException("groupId is not a valid comparison group identifier.");
            using FileStream index = File.OpenRead(Path.Combine(directory, "groups.idx"));
            if (ordinal > index.Length / sizeof(long)) throw new FileNotFoundException("The comparison group does not exist.");
            index.Position = (ordinal - 1) * sizeof(long);
            Span<byte> bytes = stackalloc byte[sizeof(long)];
            index.ReadExactly(bytes);
            using FileStream groups = File.OpenRead(Path.Combine(directory, "groups.jsonl"));
            groups.Position = BinaryPrimitives.ReadInt64LittleEndian(bytes);
            using StreamReader reader = new(groups, Encoding.UTF8);
            return JsonSerializer.Deserialize<ComparisonGroup>(reader.ReadLine()!, ViewerConstants.JsonOptions)!;
        }

        internal void Cleanup()
        {
            string? path;
            lock (this.gate)
            {
                if (!this.workerDone || this.readers != 0 || this.snapshot.State == "completed" || this.directory is null || this.cleanupInProgress) return;
                path = this.directory;
                this.directory = null;
                this.cleanupInProgress = true;
            }
            try { Directory.Delete(path, true); }
            catch (DirectoryNotFoundException) { }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                lock (this.gate)
                {
                    this.directory = path;
                    this.snapshot = this.snapshot with { Error = "Could not remove comparison work files: " + exception.Message };
                }
            }
            finally { lock (this.gate) this.cleanupInProgress = false; }
        }

        public void Dispose()
        {
            SessionCatalog.HistoryInvalidated -= this.OnHistoryInvalidated;
            lock (this.gate) this.cancellation.Dispose();
        }
    }
}
