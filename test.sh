#!/usr/bin/env bash
set -euo pipefail

# Isolate user resources, credentials, temporary files, and tool configuration.
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/pi-test.XXXXXX")"
git_askpass="$(type -P false)"
native_path() {
	case "$(uname -s)" in
		MINGW* | MSYS* | CYGWIN*) cygpath -w "$1" ;;
		*) printf '%s' "$1" ;;
	esac
}
readonly temp_parent test_root git_askpass

mkdir -p \
	"$test_root/home/.config" \
	"$test_root/tmp" \
	"$test_root/cache/npm" \
	"$test_root/appdata/local" \
	"$test_root/appdata/roaming"
# Mark the generated root so cleanup can verify ownership before deleting it.
touch "$test_root/.pi-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/pi-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.pi-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

# Start from an empty environment and allow only required platform and test settings.
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$(native_path "$test_root/home")"
	"USERPROFILE=$(native_path "$test_root/home")"
	"LOCALAPPDATA=$(native_path "$test_root/appdata/local")"
	"APPDATA=$(native_path "$test_root/appdata/roaming")"
	"TMPDIR=$(native_path "$test_root/tmp")"
	"TMP=$(native_path "$test_root/tmp")"
	"TEMP=$(native_path "$test_root/tmp")"
	"XDG_CONFIG_HOME=$(native_path "$test_root/home/.config")"
	"XDG_CACHE_HOME=$(native_path "$test_root/cache")"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$(native_path "$test_root/npm-userconfig")"
	"NPM_CONFIG_GLOBALCONFIG=$(native_path "$test_root/npm-globalconfig")"
	"NPM_CONFIG_CACHE=$(native_path "$test_root/cache/npm")"
	"PI_SANDBOX_MODE=full-access"
	"PI_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Native Windows needs these inherited values to launch child processes and
# discover browsers installed under the system program directories.
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT HOMEDRIVE HOMEPATH ProgramFiles 'ProgramFiles(x86)' ProgramW6432; do
	value="$(printenv "$name" || true)"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# Preserve CI detection only for runner behavior and test reporting.
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "Running tests without API keys in isolated home: $(native_path "$test_root/home")"
env -i "${test_env[@]}" npm test
