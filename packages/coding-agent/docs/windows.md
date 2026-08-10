# Windows Setup

Pi does not require Bash for file search or ordinary Windows commands. `grep` and `find` prefer managed native `rg.exe` and `fd.exe` binaries, resolve real executables instead of command wrappers, and fall back to the concurrent built-in filesystem backend when native tools are unavailable or offline. `ls` remains in-process. Terminal commands can run with `executor="powershell"` directly.

The managed search executables are launched directly with argument arrays and no shell. On Windows this avoids the expensive OS-sandbox initialization that would otherwise dominate a read-only search; the fallback has the same filesystem visibility as the previous in-process implementation.

Git Bash is optional and only needed for commands that require Bash syntax. When requested, Pi checks:

1. Custom path from `~/.pi/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. A real `bash.exe` on PATH (Cygwin or MSYS2; the legacy WSL relay is rejected)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
