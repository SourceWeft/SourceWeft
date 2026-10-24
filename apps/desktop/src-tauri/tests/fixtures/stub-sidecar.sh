#!/bin/sh
# Stub sidecar used only by the Rust unit tests in
# apps/desktop/src-tauri/src/local_host/sidecar.rs.
#
# Reads newline-delimited JSON requests on stdin and writes newline-delimited
# JSON replies on stdout, exactly like the real `srt-sidecar` binary (built in
# a later task). It never reads arguments or environment variables to decide
# how to behave, because the real Rust client spawns the sidecar with an
# env_clear()'d environment and no arguments. Instead each test drives the
# behavior it needs through ordinary request fields:
#   - init.config.home ending in "/exit-after-init" -> reply to init, then
#     exit (simulates a sidecar that dies right after startup)
#   - wrap.command "ERROR:<CODE>"  -> reply with ok:false, error.code=<CODE>
#   - wrap.command "HANG"          -> never reply (simulates a stuck sidecar)
#   - violations.stderr "DUMP_ENV" -> reply with the sidecar's own env var
#     names, so the test can assert no `*_PROXY` variable reached it
# Anything else gets a generic canned success reply.

extract() {
    # extract <field> <json-line>: crude single-line string-field extractor,
    # sufficient for the fixed, flat-ish request shapes the Rust client sends.
    printf '%s' "$2" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

while IFS= read -r line; do
    id=$(extract id "$line")
    op=$(extract op "$line")

    case "$op" in
        init)
            home=$(extract home "$line")
            printf '{"id":"%s","ok":true,"result":null}\n' "$id"
            case "$home" in
                */exit-after-init) exit 0 ;;
            esac
            ;;
        wrap)
            command=$(extract command "$line")
            case "$command" in
                ERROR:*)
                    code=${command#ERROR:}
                    printf '{"id":"%s","ok":false,"error":{"code":"%s","message":"stub error"}}\n' "$id" "$code"
                    ;;
                HANG)
                    sleep 10
                    ;;
                *)
                    printf '{"id":"%s","ok":true,"result":{"argv":["/bin/echo","hi"],"env":{"FOO":"bar"}}}\n' "$id"
                    ;;
            esac
            ;;
        violations)
            stderr_field=$(extract stderr "$line")
            case "$stderr_field" in
                DUMP_ENV)
                    names=$(env | cut -d= -f1 | tr '\n' ';')
                    printf '{"id":"%s","ok":true,"result":"%s"}\n' "$id" "$names"
                    ;;
                *)
                    printf '{"id":"%s","ok":true,"result":"%s"}\n' "$id" "$stderr_field"
                    ;;
            esac
            ;;
        cleanup|probe|shutdown)
            printf '{"id":"%s","ok":true,"result":null}\n' "$id"
            ;;
        *)
            printf '{"id":"%s","ok":false,"error":{"code":"BAD_REQUEST","message":"unknown op"}}\n' "$id"
            ;;
    esac
done
