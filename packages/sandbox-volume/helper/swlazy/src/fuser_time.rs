//! Attribute-wire adapter for exactly fuser 0.15.1 (registry package SHA-256
//! 53274f494609e77794b627b1a3cddfe45d675a6b2e9ba9c0fdc8d8eee2184369).
//!
//! Its private time_from_system_time encoder emits (-whole_seconds, positive
//! fractional_nanoseconds) for pre-epoch inputs, rather than normalizing the
//! negative fraction. This input deliberately targets that encoder's wire pair.
//! Never use the returned SystemTime as logical metadata, in a plan, or for
//! restore/treehash. A dependency upgrade must remove/revalidate this adapter.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn attribute_time(ns: i64) -> Option<SystemTime> {
    if ns >= 0 {
        UNIX_EPOCH.checked_add(Duration::from_nanos(ns as u64))
    } else {
        // The kernel needs floor(seconds) plus a nonnegative remainder. i64::MIN
        // is safe: negation is applied only to its much smaller second quotient.
        let seconds = ns.div_euclid(1_000_000_000);
        let nanos = ns.rem_euclid(1_000_000_000) as u32;
        UNIX_EPOCH.checked_sub(Duration::new(seconds.unsigned_abs(), nanos))
    }
}
