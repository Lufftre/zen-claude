#!/bin/sh
# Lets Claude sessions on another machine use this browser, for as long as this runs (Ctrl-C to stop).
#
#   scripts/remote-tunnel.sh ludde@rex
#
# The hub here is forwarded to ~/.zen-claude/hub.sock on that machine, in a folder only your account there can
# open, so other accounts on it can't reach the browser. Sessions there run the server with
# ZEN_CLAUDE_HUB_SOCKET=$HOME/.zen-claude/hub.sock (see "Sessions on another machine" in the README).
set -eu

host=${1:?usage: $0 <ssh host>}
port=${ZEN_CLAUDE_PORT:-8765}

# sshd won't create the folder, and won't bind over a socket left by a tunnel that dropped.
sock=$(ssh -o BatchMode=yes "$host" \
  'mkdir -p ~/.zen-claude && chmod 700 ~/.zen-claude && rm -f ~/.zen-claude/hub.sock && echo "$HOME/.zen-claude/hub.sock"')

echo "Forwarding 127.0.0.1:$port to $host:$sock; Ctrl-C to stop." >&2
exec ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -R "$sock:127.0.0.1:$port" "$host"
