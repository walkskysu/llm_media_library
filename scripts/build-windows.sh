#!/usr/bin/env bash
# Cross-compile the Windows NSIS installer on Linux (Debian/Ubuntu).
#
# Requires: Node.js, rustup. If NSIS / LLVM (llvm-rc, lld-link, clang) are not
# installed system-wide, they are fetched with `apt-get download` and unpacked
# into ~/.local/xtools — no root needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
X="${XTOOLS_DIR:-$HOME/.local/xtools}"
LLVM_VER="${LLVM_VER:-}"

need_local_tools=0
for t in makensis llvm-rc lld-link clang-cl; do
  command -v "$t" >/dev/null 2>&1 || need_local_tools=1
done

if [[ $need_local_tools == 1 ]]; then
  if [[ -z "$LLVM_VER" ]]; then
    LLVM_VER="$(apt-cache depends llvm | sed -n 's/.*Depends: llvm-\([0-9]\+\)$/\1/p' | head -1)"
  fi
  echo ">> Fetching NSIS + LLVM $LLVM_VER into $X"
  if [[ ! -x "$X/usr/lib/llvm-$LLVM_VER/bin/llvm-rc" || ! -x "$X/usr/bin/makensis" ]]; then
    tmp="$(mktemp -d)"
    (cd "$tmp" && apt-get download nsis nsis-common "llvm-$LLVM_VER" "lld-$LLVM_VER" "clang-$LLVM_VER" \
      "libllvm$LLVM_VER" "libclang-cpp$LLVM_VER" "libclang-common-$LLVM_VER-dev" "llvm-$LLVM_VER-linker-tools")
    for f in "$tmp"/*.deb; do dpkg -x "$f" "$X"; done
    rm -rf "$tmp"
  fi
  mkdir -p "$X/bin"
  for t in clang lld-link llvm-rc llvm-lib lld llvm-ar; do
    ln -sf "$X/usr/lib/llvm-$LLVM_VER/bin/$t" "$X/bin/$t"
  done
  ln -sf "$X/usr/lib/llvm-$LLVM_VER/bin/clang" "$X/bin/clang-cl"
  ln -sf "$X/usr/bin/makensis" "$X/bin/makensis"
  export PATH="$X/bin:$PATH"
  export LD_LIBRARY_PATH="$X/usr/lib/x86_64-linux-gnu:$X/usr/lib/llvm-$LLVM_VER/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export NSISDIR="$X/usr/share/nsis"
fi

rustup target add x86_64-pc-windows-msvc
command -v cargo-xwin >/dev/null 2>&1 || cargo install --locked cargo-xwin

cd "$ROOT"
[[ -d node_modules ]] || npm install
npm run build:windows

echo
echo ">> Installer:"
ls -1 "$ROOT"/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
