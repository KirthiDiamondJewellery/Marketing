#!/usr/bin/env bash
# Signs in to Claude once and prints a long-lived sign-in token (sk-ant-oat01-…) on stdout, nothing else.
#
# It runs `claude setup-token` in your terminal: a browser opens, you approve, and the token comes back. AttentionOS
# keeps the token in the stack's .env (readable only by you) so your agents run on your own Claude plan.
# Run it on a computer with a browser. Used by `./aos claude-login`.
#
# Exit codes: 0 token printed · 2 no terminal to sign in with · 3 Claude Code missing and couldn't be installed
#             4 no token
set -euo pipefail

say() { printf '%s\n' "$*" >/dev/tty; }

if ! { : >/dev/tty; } 2>/dev/null; then
  echo "Signing in to Claude needs a terminal. Run ./aos claude-login later." >&2
  exit 2
fi

export PATH="$PATH:$HOME/.local/bin:$HOME/.claude/local:/usr/local/bin:/opt/homebrew/bin"
if ! command -v claude >/dev/null 2>&1; then
  say "Installing Claude Code (Anthropic's command-line app, used once to sign in)…"
  if command -v npm >/dev/null 2>&1 && npm install -g --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code >/dev/tty 2>&1; then
    :
  else
    # The official installer, no Node.js needed.
    curl -fsSL https://claude.ai/install.sh | bash >/dev/tty 2>&1 || true
  fi
  hash -r
  command -v claude >/dev/null 2>&1 || { echo "Couldn't install Claude Code. Install it from https://code.claude.com and run this again." >&2; exit 3; }
fi

say ""
say "Sign in to Claude: a browser window opens. Approve it with the Claude account you want your agents to use."
say "(It needs a Claude Pro or Max plan. No browser opened? Copy the link shown below into one.)"
say ""

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
# Record the session so the token can be picked out of it, while you see and use it normally.
if [ "$(uname -s)" = "Darwin" ]; then
  script -q "$log" claude setup-token </dev/tty >/dev/tty 2>&1 || true
else
  script -q -e -c "claude setup-token" "$log" </dev/tty >/dev/tty 2>&1 || true
fi

# Strip terminal colours, then collect candidate tokens: the token as printed on its line, plus versions re-joined
# with following lines in case the terminal wrapped it. The words after it on screen ("Store this token…") can look
# like a wrapped tail, so every candidate is tested with a one-line Claude request and only a working one is kept.
esc="$(printf '\033')"
candidates="$(sed -e "s/${esc}\[[0-9;?]*[A-Za-z]//g" -e "s/${esc}\][^$(printf '\007')]*$(printf '\007')//g" "$log" | tr -d '\r' | awk '
  { gsub(/^[ \t]+|[ \t]+$/, "") }
  t != "" && n < 3 { if ($0 ~ /^[A-Za-z0-9_-]+$/) { t = t $0; n++; print t; next } else { n = 3 } }
  { i = index($0, "sk-ant-oat01-")
    if (i) { m = substr($0, i); sub(/[^A-Za-z0-9_-].*$/, "", m); t = m; n = 0; print t } }')"

token=""
say ""
say "Checking the sign-in works…"
# Shortest first: a real token is never a prefix of a working longer one.
while IFS= read -r cand; do
  [ "${#cand}" -ge 80 ] || continue
  if CLAUDE_CODE_OAUTH_TOKEN="$cand" claude -p "Reply with the single word: ok" --max-turns 1 </dev/null >/dev/null 2>&1; then
    token="$cand"
    break
  fi
done < <(printf '%s\n' "$candidates" | awk 'NF' | awk '{ print length, $0 }' | sort -n | cut -d" " -f2- | uniq)

if [ -z "$token" ]; then
  say ""
  say "Copy the token it printed (it starts with sk-ant-oat01-) and paste it here, then press Enter."
  say "(Nothing shows while you paste. Press Enter on its own to skip for now.)"
  IFS= read -r -s token </dev/tty || token=""
  say ""
  token="$(printf '%s' "$token" | tr -d '[:space:]')"
fi

case "$token" in
  sk-ant-oat01-*) printf '%s\n' "$token" ;;
  *) echo "No sign-in token, so Claude isn't connected yet. Sign in later with ./aos claude-login" >&2; exit 4 ;;
esac
