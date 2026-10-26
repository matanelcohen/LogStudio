using System;
using Xunit;

namespace LogStudio.Tests;

public sealed class LogCsvTests
{
    [Fact]
    public void CsvQuotesDelimitersQuotesMultilineAndUnicode()
    {
        LogEntry entry = new(42, new DateTimeOffset(2026, 10, 11, 18, 0, 0, TimeSpan.Zero),
            LogStream.Stderr, LogSeverity.Error, "Category,\"quoted\"", "line one,\r\n\"line two\" \u00e9", true);
        Assert.Equal("\"42\",\"2026-10-11T18:00:00.0000000+00:00\",\"stderr\",\"error\",\"Category,\"\"quoted\"\"\",\"line one,\r\n\"\"line two\"\" \u00e9\",\"true\"", LogCsv.Record(entry));
    }

    [Theory]
    [InlineData("=1+1")]
    [InlineData("+1+1")]
    [InlineData("-1+1")]
    [InlineData("@SUM(1)")]
    [InlineData("  =1+1")]
    [InlineData("\tformula")]
    [InlineData("\rformula")]
    [InlineData("\nformula")]
    public void CsvNeutralizesFormulaPrefixesInBothTextFields(string value)
    {
        LogEntry entry = new(1, DateTimeOffset.UnixEpoch, LogStream.Stdout, LogSeverity.Output, value, value, false);
        Assert.Contains(",\"'" + value + "\",\"'" + value + "\",", LogCsv.Record(entry), StringComparison.Ordinal);
        Assert.Equal(value, entry.Message);
    }

    [Fact]
    public void CsvKeepsEmptyCategoryAndMessageAsEmptyCells()
    {
        LogEntry entry = new(1, DateTimeOffset.UnixEpoch, LogStream.Stdout, LogSeverity.Output, null, "", false);
        Assert.EndsWith(",\"\",\"\",\"false\"", LogCsv.Record(entry), StringComparison.Ordinal);
    }
}
