# Source this file:  . ./idf-env.sh
# ESP-IDF v5.5's Python env was built on uv-managed Python 3.12 because the
# system Python (3.14) is newer than IDF v5.5 supports.
_py312="$(uv python find 3.12 2>/dev/null)"
if [ -z "$_py312" ]; then
    echo "uv-managed Python 3.12 not found: run 'uv python install 3.12'" >&2
    return 1
fi
export PATH="$(dirname "$_py312"):$PATH"
. "${IDF_PATH:-$HOME/esp/esp-idf}/export.sh" >/dev/null
unset _py312
