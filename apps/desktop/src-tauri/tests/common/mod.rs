//! Helpers shared by the integration tests.
#![allow(dead_code)]
use serde_json::Value;

/// The shape every `command.execute` result has, on every platform: the four original fields
/// with the right types, and nothing else except the optional extras a sandboxed run adds
/// (`networkAudit`, `networkAuditError`, `vaultWarning`). Panics naming the problem otherwise.
pub fn assert_result_shape(result: &Value) {
    let object = result
        .as_object()
        .unwrap_or_else(|| panic!("result is not an object: {result}"));
    assert!(object.get("output").is_some_and(Value::is_string), "output: {result}");
    assert!(object.get("exitCode").is_some_and(Value::is_i64), "exitCode: {result}");
    assert!(object.get("truncated").is_some_and(Value::is_boolean), "truncated: {result}");
    assert!(object.get("cancelled").is_some_and(Value::is_boolean), "cancelled: {result}");
    for key in object.keys() {
        assert!(
            ["output", "exitCode", "truncated", "cancelled", "networkAudit", "networkAuditError", "vaultWarning"]
                .contains(&key.as_str()),
            "unexpected result key {key:?}: {result}"
        );
    }
    if let Some(audit) = object.get("networkAudit") {
        assert!(audit.is_array(), "networkAudit must be an array: {result}");
    }
    for key in ["networkAuditError", "vaultWarning"] {
        if let Some(value) = object.get(key) {
            assert!(value.is_string(), "{key} must be a string: {result}");
        }
    }
}
