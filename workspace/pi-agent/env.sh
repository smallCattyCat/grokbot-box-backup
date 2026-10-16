# Source before running pi on this box
export PATH="$HOME/.local/share/fnm:$HOME/.local/bin:$PATH"
eval "$(fnm env --shell bash)"
fnm use 22 >/dev/null
# OPENCODE_API_KEY must already be in the process env (Grok Bot secret)
