[CmdletBinding()]
param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]] $PiArguments
)

$ErrorActionPreference = "Stop"
$piDevRoot = Split-Path -Parent $PSScriptRoot
$piDevCli = Join-Path $piDevRoot "packages\coding-agent\src\cli.ts"
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue

if ($null -eq $nodeCommand) {
	throw "pi-dev requires Node.js 22.19 or later."
}
if (-not (Test-Path -LiteralPath $piDevCli -PathType Leaf)) {
	throw "pi-dev entrypoint is missing: $piDevCli"
}

Push-Location -LiteralPath $piDevRoot
try {
	& $nodeCommand.Source --experimental-strip-types --disable-warning=ExperimentalWarning $piDevCli @PiArguments
}
finally {
	Pop-Location
}
