using System;
using System.Collections.Specialized;
using System.Text.Json;
using System.Threading;
using Xunit;

namespace LogStudio.Tests;

public sealed class ConditionTests
{
    private const string ApplicationCategory = "Application.Skill";
    private const string FrameworkCategory = "Microsoft.Hosting";
    private const string LargeRegexInputSuffix = "!";
    private const int LargeRegexInputLength = 16_000;

    [Theory]
    [InlineData("contains", "retry", "Please retry the skill", true)]
    [InlineData("equals", "ERROR", "error", true)]
    [InlineData("equals", "error", "errors", false)]
    [InlineData("startsWith", "Microsoft.", "Microsoft.Hosting", true)]
    [InlineData("endsWith", ".Skill", "Application.Skill", true)]
    [InlineData("regex", "^retry [0-9]+$", "retry 42", true)]
    [InlineData("regex", "^retry [0-9]+$", "retry abc", false)]
    public void ConditionsMatchSupportedOperators(string operation, string pattern, string text, bool expected)
    {
        CompiledLogCondition condition = new(new LogCondition("include", "message", operation, pattern), false);
        Assert.Equal(expected, condition.Matches(text));
    }

    [Fact]
    public void MatchCaseAppliesToLiteralAndRegexConditions()
    {
        foreach (string operation in new[] { "contains", "equals", "startsWith", "endsWith", "regex" })
        {
            CompiledLogCondition insensitive = new(new LogCondition("include", "message", operation, "RETRY"), false);
            CompiledLogCondition sensitive = new(new LogCondition("include", "message", operation, "RETRY"), true);
            Assert.True(insensitive.Matches("retry"));
            Assert.False(sensitive.Matches("retry"));
        }
    }

    [Fact]
    public void IncludesSupportAllOrAnyAndExcludesAlwaysWin()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        store.Append("retry now", LogStream.Stdout, severity: LogSeverity.Warning, category: ApplicationCategory);
        store.Append("failure", LogStream.Stderr, severity: LogSeverity.Error, category: ApplicationCategory);
        store.Append("retry now", LogStream.Stdout, severity: LogSeverity.Warning, category: FrameworkCategory);
        LogCondition[] conditions =
        {
            new("include", "message", "contains", "retry"),
            new("include", "level", "equals", "error"),
            new("exclude", "category", "startsWith", "Microsoft."),
        };
        using LogHistoryReader history = store.OpenHistory();
        LogQuery all = Query(conditions, "all");
        Assert.Equal(0, all.Search(history, CancellationToken.None).MatchCount);
        LogQuery any = Query(conditions, "any");
        LogSearchResult result = any.Search(history, CancellationToken.None);
        Assert.Equal(2, result.MatchCount);
        Assert.Equal(1, result.ErrorCount);
        Assert.Equal(1, result.WarningCount);
    }

    [Fact]
    public void ExclusionOnlyQueryDoesNotRequireAnIncludeCondition()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        store.Append("heartbeat", LogStream.Stdout);
        store.Append("important", LogStream.Stdout);
        using LogHistoryReader history = store.OpenHistory();
        LogQuery query = Query(new[] { new LogCondition("exclude", "message", "equals", "heartbeat") }, "any");
        Assert.Equal("important", Assert.Single(query.Search(history, CancellationToken.None).Entries).Message);
    }

    [Fact]
    public void RegexConditionsUseLinearTimeMatchingForNestedQuantifiers()
    {
        CompiledLogCondition condition = new(new LogCondition("exclude", "message", "regex", "^(a+)+$"), false);
        Assert.False(condition.Matches(new string('a', LargeRegexInputLength) + LargeRegexInputSuffix));
    }

    [Theory]
    [InlineData("[")]
    [InlineData("(?<=prefix)text")]
    [InlineData("(text)\\1")]
    public void UnsupportedOrInvalidRegexConditionsFailExplicitly(string pattern)
    {
        Assert.Throws<ArgumentException>(() => new CompiledLogCondition(new LogCondition("include", "message", "regex", pattern), false));
    }

    [Theory]
    [InlineData("{")]
    [InlineData("null")]
    [InlineData("[null]")]
    [InlineData("[{\"mode\":\"maybe\",\"field\":\"message\",\"operator\":\"contains\",\"value\":\"x\"}]")]
    [InlineData("[{\"mode\":\"include\",\"field\":\"missing\",\"operator\":\"contains\",\"value\":\"x\"}]")]
    [InlineData("[{\"mode\":\"include\",\"field\":\"message\",\"operator\":\"unknown\",\"value\":\"x\"}]")]
    [InlineData("[{\"mode\":\"include\",\"field\":\"message\",\"operator\":\"contains\",\"value\":\"\"}]")]
    public void InvalidConditionDefinitionsAreRejected(string filters)
    {
        Assert.Throws<ArgumentException>(() => LogQuery.Parse(new NameValueCollection { [ViewerConstants.ConditionsQuery] = filters }));
    }

    private static LogQuery Query(LogCondition[] conditions, string mode) => LogQuery.Parse(new NameValueCollection
    {
        [ViewerConstants.ConditionsQuery] = JsonSerializer.Serialize(conditions, ViewerConstants.JsonOptions),
        [ViewerConstants.IncludeModeQuery] = mode,
    });
}
