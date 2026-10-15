#!/data/data/com.termux/files/usr/bin/sh
# Netlify CLI for this project (borrows the install in ~/projects/jev-netlify; termux-exec fixes child shebangs).
cd "$(dirname "$0")" && LD_PRELOAD=$PREFIX/lib/libtermux-exec.so exec node "$HOME/projects/jev-netlify/node_modules/netlify-cli/bin/run.js" "$@"
