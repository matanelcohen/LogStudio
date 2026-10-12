using System;
using System.Text.RegularExpressions;

namespace LogStudio;

internal sealed record LogCondition(string Mode, string Field, string Operator, string Value);

internal sealed class CompiledLogCondition
{
    private readonly Regex? regex;
    private readonly StringComparison comparison;

    internal CompiledLogCondition(LogCondition condition, bool matchCase)
    {
        if (condition.Mode is not (ViewerConstants.IncludeConditionMode or ViewerConstants.ExcludeConditionMode))
            throw new ArgumentException("Condition mode must be include or exclude.");
        if (condition.Field is not (ViewerConstants.MessageField or ViewerConstants.CategoryField or ViewerConstants.LevelField or ViewerConstants.StreamField or ViewerConstants.IdField))
            throw new ArgumentException("Condition field must be message, category, level, stream or id.");
        if (condition.Operator is not (ViewerConstants.ContainsOperator or ViewerConstants.EqualsOperator or ViewerConstants.StartsWithOperator or ViewerConstants.EndsWithOperator or ViewerConstants.RegexOperator))
            throw new ArgumentException("Condition operator is not supported.");
        if (string.IsNullOrEmpty(condition.Value) || condition.Value.Length > ViewerConstants.MaximumConditionValueLength)
            throw new ArgumentException("Condition values must contain 1-256 characters.");

        this.Condition = condition;
        this.comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
        if (condition.Operator == ViewerConstants.RegexOperator)
        {
            RegexOptions options = RegexOptions.CultureInvariant | RegexOptions.NonBacktracking;
            if (!matchCase) options |= RegexOptions.IgnoreCase;
            try
            {
                this.regex = new Regex(condition.Value, options, ViewerConstants.RegexTimeout);
            }
            catch (ArgumentException exception)
            {
                throw new ArgumentException($"Invalid regular-expression condition: {exception.Message}", exception);
            }
            catch (NotSupportedException exception)
            {
                throw new ArgumentException("Regex conditions use linear-time syntax. Lookarounds and backreferences are not supported.", exception);
            }
        }
    }

    internal LogCondition Condition { get; }

    internal bool Matches(string value) => this.Condition.Operator switch
    {
        ViewerConstants.ContainsOperator => value.Contains(this.Condition.Value, this.comparison),
        ViewerConstants.EqualsOperator => string.Equals(value, this.Condition.Value, this.comparison),
        ViewerConstants.StartsWithOperator => value.StartsWith(this.Condition.Value, this.comparison),
        ViewerConstants.EndsWithOperator => value.EndsWith(this.Condition.Value, this.comparison),
        ViewerConstants.RegexOperator => this.regex?.IsMatch(value) ?? throw new InvalidOperationException("The regex condition was not compiled."),
        _ => throw new InvalidOperationException("The condition operator was not validated."),
    };
}
