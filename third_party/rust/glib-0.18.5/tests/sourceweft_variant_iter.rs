use glib::{variant::ToVariant, Variant};

fn strings() -> Variant {
    Variant::array_from_iter::<String>(["first", "中文", "last"].map(|s| s.to_variant()))
}

#[test]
fn forward_and_reverse_preserve_utf8_values() {
    let value = strings();
    assert_eq!(
        value.array_iter_str().unwrap().collect::<Vec<_>>(),
        ["first", "中文", "last"]
    );
    assert_eq!(
        value.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        ["last", "中文", "first"]
    );
}

#[test]
fn mixed_iteration_visits_each_value_once() {
    let value = strings();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some("中文"));
    assert_eq!(iter.next_back(), None);
    assert_eq!(iter.next(), None);
}

#[test]
fn nth_and_last_read_real_values_in_optimized_builds() {
    let value = strings();
    assert_eq!(value.array_iter_str().unwrap().nth(1), Some("中文"));
    assert_eq!(value.array_iter_str().unwrap().last(), Some("last"));
}

#[test]
fn empty_string_array_is_exhausted() {
    let value = Vec::<String>::new().to_variant();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
    assert_eq!(iter.len(), 0);
}
