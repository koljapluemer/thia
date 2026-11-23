//! What a model's tokens cost, in dollars per million: Anthropic's list prices on [`AS_OF`]. Cost is derived from a
//! run's tokens when it's indexed, never kept in its record: a price that changes or was wrong here changes
//! [`super::index::VERSION`], and reindexing re-derives every run's.

pub const AS_OF: &str = "2026-11-03";

/// By model prefix (the longest that matches): input, output, cache read, cache write (5 minutes).
const PRICES: &[(&str, [f64; 4])] = &[
    ("claude-fable-5-2", [8.0, 40.0, 0.20, 10.0]),
    ("claude-mythos-5-2", [8.0, 40.0, 0.20, 10.0]),
    ("claude-fable-5", [10.0, 50.0, 1.0, 12.5]),
    ("claude-mythos-5", [10.0, 50.0, 1.0, 12.5]),
    ("claude-opus-5-5", [4.0, 20.0, 0.20, 5.0]),
    ("claude-opus-5", [5.0, 25.0, 0.50, 6.25]),
    ("claude-opus-4", [5.0, 25.0, 0.50, 6.25]),
    ("claude-sonnet-5-5", [2.0, 10.0, 0.10, 2.5]),
    ("claude-sonnet-5", [2.0, 10.0, 0.20, 2.5]),
    ("claude-sonnet-4", [3.0, 15.0, 0.30, 3.75]),
    ("claude-haiku-5-5", [0.10, 0.50, 0.01, 0.125]),
    ("claude-haiku-4", [1.0, 5.0, 0.10, 1.25]),
];

/// What these tokens of `model` cost, or `None` for a model without a price here.
pub fn cost(model: &str, input: i64, output: i64, cache_read: i64, cache_write: i64) -> Option<f64> {
    let model = model.trim().to_ascii_lowercase();
    let (_, p) = PRICES.iter().filter(|(prefix, _)| model.starts_with(prefix)).max_by_key(|(prefix, _)| prefix.len())?;
    Some((input as f64 * p[0] + output as f64 * p[1] + cache_read as f64 * p[2] + cache_write as f64 * p[3]) / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_longest_prefix_prices_it() {
        assert_eq!(cost("claude-opus-5-5", 1_000_000, 0, 0, 0), Some(4.0));
        assert_eq!(cost("claude-opus-5", 1_000_000, 0, 0, 0), Some(5.0));
        assert_eq!(cost("claude-opus-5-5[1m]", 0, 1_000_000, 0, 0), Some(20.0));
        assert_eq!(cost("qwen3.5:9b", 1, 1, 0, 0), None);
    }
}
