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
#   - init.config.home ending in "/protocol-<X>" -> reply to init with a different
#     protocolVersion result: "protocol-0" -> 0, "protocol-1" -> 1 (a bundle from before the
#     network-approval protocol), "protocol-3" -> 3, "protocol-string" ->
#     "1" (a string), "protocol-float" -> 1.5, "protocol-missing" -> {} (no field),
#     "protocol-null" -> null (the pre-handshake reply). Anything else replies 2, which is
#     SANDBOX_PROTOCOL_VERSION in sandbox-sidecar/src/protocol.ts.
#   - init.config.home ending in "/record-ops" -> append "<op> <commandId>"
#     for every later request to "<home>.log" (srt_exec.rs cleanup tests)
#   - wrap.command "ASK:<host>:<port>"        -> reply to the wrap, then emit an
#     unsolicited {"event":"ask",...} line (askId "ask-1", the request's commandId)
#   - wrap.command "EVENT_FIRST:<host>:<port>" -> emit the ask event BEFORE the wrap reply
#     (an event arriving mid-call)
#   - wrap.command "SLEEP_ASK:<host>:<port>"   -> like ASK, but the wrapped argv is
#     `sleep 2` so the command outlives the approval round trip
#   - wrap.command "SLEEP_ASK_OTHER:<host>:<port>" -> like SLEEP_ASK, but the event names a
#     different commandId than the wrap's
#   - wrap.command "SHOW_NETWORK"  -> reply argv ["/bin/echo", <the request's raw
#     `network` JSON, or empty>] so tests can see what reached the wire
#   - ask.reply -> reply ok (askId "ask-gone" -> BAD_REQUEST "no pending ask ..."); with "record-ops" also logs "ask.reply <askId> <allow> <reason>"
#   - audit     -> reply one canned entry whose "decision" is the allow/deny of the last
#     ask.reply received ("unanswered" before any); commandId "AUDIT_ERROR" -> BAD_REQUEST
#   - wrap.command "AUDIT_FAIL" -> normal wrap reply, but every later audit is BAD_REQUEST
#   - A wrap command may be preceded by "...\n" lines (srt_exec prefixes a TMPDIR export);
#     only the text after the last literal backslash-n is matched.
# Anything else gets a generic canned success reply.

extract() {
    # extract <field> <json-line>: crude single-line string-field extractor,
    # sufficient for the fixed, flat-ish request shapes the Rust client sends.
    printf '%s' "$2" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

# Emits the unsolicited ask event for a "<host>:<port>" pair and the given command id.
emit_ask() {
    host=${1%%:*}
    port=${1##*:}
    printf '{"event":"ask","askId":"ask-1","commandId":"%s","host":"%s","port":%s}\n' "$2" "$host" "$port"
}

answered=unanswered
audit_fails=

while IFS= read -r line; do
    id=$(extract id "$line")
    op=$(extract op "$line")
    if [ -n "$record" ]; then
        if [ "$op" = "ask.reply" ]; then
            allow=$(printf '%s' "$line" | sed -n 's/.*"allow":\([a-z]*\).*/\1/p')
            printf 'ask.reply %s %s %s\n' "$(extract askId "$line")" "$allow" "$(extract reason "$line")" >> "$record"
        else
            printf '%s %s\n' "$op" "$(extract commandId "$line")" >> "$record"
        fi
    fi

    case "$op" in
        init)
            home=$(extract home "$line")
            case "$home" in
                */protocol-0) result='{"protocolVersion":0}' ;;
                */protocol-1) result='{"protocolVersion":1}' ;;
                */protocol-3) result='{"protocolVersion":3}' ;;
                */protocol-string) result='{"protocolVersion":"1"}' ;;
                */protocol-float) result='{"protocolVersion":1.5}' ;;
                */protocol-missing) result='{}' ;;
                */protocol-null) result='null' ;;
                *) result='{"protocolVersion":2}' ;;
            esac
            printf '{"id":"%s","ok":true,"result":%s}\n' "$id" "$result"
            case "$home" in
                */exit-after-init) exit 0 ;;
                */record-ops) record="$home.log" ;;
            esac
            ;;
        wrap)
            command=$(extract command "$line")
            command=${command##*'\n'}
            case "$command" in
                ERROR:*)
                    code=${command#ERROR:}
                    printf '{"id":"%s","ok":false,"error":{"code":"%s","message":"stub error"}}\n' "$id" "$code"
                    ;;
                HANG)
                    sleep 10
                    ;;
                ASK:*)
                    printf '{"id":"%s","ok":true,"result":{"argv":["/bin/echo","hi"],"env":{"FOO":"bar"}}}\n' "$id"
                    emit_ask "${command#ASK:}" "$(extract commandId "$line")"
                    ;;
                EVENT_FIRST:*)
                    emit_ask "${command#EVENT_FIRST:}" "$(extract commandId "$line")"
                    printf '{"id":"%s","ok":true,"result":{"argv":["/bin/echo","hi"],"env":{"FOO":"bar"}}}\n' "$id"
                    ;;
                SLEEP_ASK:*)
                    printf '{"id":"%s","ok":true,"result":{"argv":["/bin/sleep","2"],"env":{"FOO":"bar"}}}\n' "$id"
                    emit_ask "${command#SLEEP_ASK:}" "$(extract commandId "$line")"
                    ;;
                AUDIT_FAIL)
                    audit_fails=1
                    printf '{"id":"%s","ok":true,"result":{"argv":["/bin/echo","hi"],"env":{"FOO":"bar"}}}\n' "$id"
                    ;;
                SLEEP_ASK_OTHER:*)
                    printf '{"id":"%s","ok":true,"result":{"argv":["/bin/sleep","2"],"env":{"FOO":"bar"}}}\n' "$id"
                    emit_ask "${command#SLEEP_ASK_OTHER:}" "some-other-command"
                    ;;
                SHOW_NETWORK)
                    net=$(printf '%s' "$line" | sed -n 's/.*"network":\(.*\)}$/\1/p' | sed 's/"/\\"/g')
                    printf '{"id":"%s","ok":true,"result":{"argv":["/bin/echo","%s"],"env":{}}}\n' "$id" "$net"
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
        ask.reply)
            if [ "$(extract askId "$line")" = "ask-gone" ]; then
                # Like the real sidecar for an unknown / already answered / timed-out ask.
                printf '{"id":"%s","ok":false,"error":{"code":"BAD_REQUEST","message":"no pending ask \\"ask-gone\\" (unknown, already answered or timed out)"}}\n' "$id"
                continue
            fi
            case "$line" in
                *'"allow":true'*) answered=allow ;;
                *) answered=deny ;;
            esac
            printf '{"id":"%s","ok":true,"result":null}\n' "$id"
            ;;
        audit)
            if [ "$(extract commandId "$line")" = "AUDIT_ERROR" ] || [ -n "$audit_fails" ]; then
                printf '{"id":"%s","ok":false,"error":{"code":"BAD_REQUEST","message":"stub audit error"}}\n' "$id"
            else
                printf '{"id":"%s","ok":true,"result":{"entries":[{"t":1,"kind":"connection","host":"example.com","port":443,"decision":"%s","source":"approval"}]}}\n' "$id" "$answered"
            fi
            ;;
        cleanup|probe|shutdown)
            printf '{"id":"%s","ok":true,"result":null}\n' "$id"
            ;;
        *)
            printf '{"id":"%s","ok":false,"error":{"code":"BAD_REQUEST","message":"unknown op"}}\n' "$id"
            ;;
    esac
done
