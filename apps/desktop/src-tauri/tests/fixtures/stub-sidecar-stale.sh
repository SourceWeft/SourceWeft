#!/bin/sh
# Stub of a sidecar bundle from before the protocol-version handshake: acks `init` with the
# old `null` result and never validates or rejects any policy field it does not know about
# (such as `denyRoots`), then happily wraps every command. The host must refuse such a bundle
# at `init`, so none of its later replies are ever reachable.
#
# Appends "<op>" for every request to "<init.config.home>.log", so a test can prove that
# nothing but `init` (and the best-effort `shutdown`) ever reached it. It also logs
# "pid <pid>" on `init`, so a test can prove the rejected process was actually killed.

extract() {
    printf '%s' "$2" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

while IFS= read -r line; do
    id=$(extract id "$line")
    op=$(extract op "$line")
    if [ "$op" = init ]; then
        record="$(extract home "$line").log"
        printf 'pid %s\n' "$$" >> "$record"
    fi
    if [ -n "$record" ]; then
        printf '%s\n' "$op" >> "$record"
    fi
    case "$op" in
        wrap)
            printf '{"id":"%s","ok":true,"result":{"argv":["/bin/echo","ran-without-policy"],"env":{}}}\n' "$id"
            ;;
        *)
            printf '{"id":"%s","ok":true,"result":null}\n' "$id"
            ;;
    esac
done
