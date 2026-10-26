#!/bin/sh
# Stub sidecar used only by the `sidecar_failure_message_is_reported_verbatim` test in
# apps/desktop/src-tauri/src/local_host/readiness.rs.
#
# Acks `init` normally (unlike stub-sidecar.sh's "/exit-after-init" trick, this process stays
# alive), then replies to every `probe` request with a fixed `ok:false` error of its own. That
# makes the test deterministic: the previous approach (exiting the process right after `init`
# and letting the following `probe` call discover the dead process) raced the Rust client's
# own stdin write for that `probe` request against the process actually having exited, so the
# reported reason varied between "failed to write to sidecar: Broken pipe (os error 32)" and
# "sidecar exited without replying" depending on scheduling. Replying to `probe` with a fixed
# message removes that race entirely.

extract() {
    printf '%s' "$2" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

while IFS= read -r line; do
    id=$(extract id "$line")
    op=$(extract op "$line")

    case "$op" in
        init)
            printf '{"id":"%s","ok":true,"result":{"protocolVersion":1}}\n' "$id"
            ;;
        probe)
            printf '{"id":"%s","ok":false,"error":{"code":"SANDBOX_UNAVAILABLE","message":"stub probe failure for readiness test"}}\n' "$id"
            ;;
        *)
            printf '{"id":"%s","ok":true,"result":null}\n' "$id"
            ;;
    esac
done
