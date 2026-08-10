[CmdletBinding(DefaultParameterSetName = "Run")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Run")]
    [string]$Request,

    [Parameter(Mandatory = $true, ParameterSetName = "Probe")]
    [switch]$Probe
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class PiSandboxNative
{
    private const uint CreateSuspended = 0x00000004;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint DisableMaxPrivilege = 0x00000001;
    private const uint LuaToken = 0x00000004;
    private const uint WriteRestricted = 0x00000008;
    private const uint TokenAssignPrimary = 0x0001;
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustPrivileges = 0x0020;
    private const uint TokenAdjustDefault = 0x0080;
    private const uint TokenAdjustSessionId = 0x0100;
    private const int TokenGroups = 2;
    private const int TokenDefaultDacl = 6;
    private const int WinWorldSid = 1;
    private const uint JobObjectLimitActiveProcess = 0x00000008;
    private const uint JobObjectLimitJobMemory = 0x00000200;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const uint Infinite = 0xFFFFFFFF;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenDefaultDaclInfo
    {
        public IntPtr DefaultDacl;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAndAttributes
    {
        public Luid Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        public uint PrivilegeCount;
        public LuidAndAttributes Privileges;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr token,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateWellKnownSid(
        int sidType,
        IntPtr domainSid,
        IntPtr sid,
        ref uint sidSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(
        IntPtr existingToken,
        uint flags,
        uint disableSidCount,
        IntPtr sidsToDisable,
        uint deletePrivilegeCount,
        IntPtr privilegesToDelete,
        uint restrictedSidCount,
        IntPtr sidsToRestrict,
        out IntPtr newToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(
        IntPtr token,
        int informationClass,
        ref TokenDefaultDaclInfo information,
        uint informationLength);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(string systemName, string name, out Luid luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(
        IntPtr token,
        bool disableAllPrivileges,
        ref TokenPrivileges newState,
        uint bufferLength,
        IntPtr previousState,
        IntPtr returnLength);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUserW(
        IntPtr token,
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void ThrowLastError(string operation)
    {
        int error = Marshal.GetLastWin32Error();
        throw new Win32Exception(error, operation + " (Win32 error " + error + ")");
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length == 0) return "\"\"";
        bool needsQuotes = false;
        for (int i = 0; i < argument.Length; i++)
        {
            char current = argument[i];
            if (char.IsWhiteSpace(current) || current == '"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return argument;

        StringBuilder result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        foreach (char current in argument)
        {
            if (current == '\\')
            {
                slashes++;
                continue;
            }
            if (current == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(current);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static string BuildCommandLine(string command, string[] arguments)
    {
        StringBuilder result = new StringBuilder(QuoteArgument(command));
        foreach (string argument in arguments)
        {
            result.Append(' ');
            result.Append(QuoteArgument(argument));
        }
        return result.ToString();
    }

    private static IntPtr CreateLimitedJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) ThrowLastError("CreateJobObject failed");
        JobObjectExtendedLimitInformation limits = new JobObjectExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags =
            JobObjectLimitKillOnJobClose | JobObjectLimitActiveProcess | JobObjectLimitJobMemory;
        limits.BasicLimitInformation.ActiveProcessLimit = 64;
        limits.JobMemoryLimit = (UIntPtr)(8UL * 1024UL * 1024UL * 1024UL);
        int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, buffer, (uint)size))
            {
                ThrowLastError("SetInformationJobObject failed");
            }
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void SetPermissiveDefaultDacl(IntPtr token, IntPtr[] sids)
    {
        RawAcl acl = new RawAcl(GenericAcl.AclRevision, sids.Length);
        for (int index = 0; index < sids.Length; index++)
        {
            acl.InsertAce(index, new CommonAce(
                AceFlags.None,
                AceQualifier.AccessAllowed,
                unchecked((int)0x10000000),
                new SecurityIdentifier(sids[index]),
                false,
                null));
        }
        byte[] binaryAcl = new byte[acl.BinaryLength];
        acl.GetBinaryForm(binaryAcl, 0);
        IntPtr aclBuffer = Marshal.AllocHGlobal(binaryAcl.Length);
        try
        {
            Marshal.Copy(binaryAcl, 0, aclBuffer, binaryAcl.Length);
            TokenDefaultDaclInfo information = new TokenDefaultDaclInfo { DefaultDacl = aclBuffer };
            if (!SetTokenInformation(
                    token,
                    TokenDefaultDacl,
                    ref information,
                    (uint)Marshal.SizeOf(typeof(TokenDefaultDaclInfo))))
            {
                ThrowLastError("SetTokenInformation(TokenDefaultDacl) failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(aclBuffer);
        }
    }

    private static void EnableChangeNotifyPrivilege(IntPtr token)
    {
        Luid luid;
        if (!LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out luid))
        {
            ThrowLastError("LookupPrivilegeValue failed");
        }
        TokenPrivileges privileges = new TokenPrivileges
        {
            PrivilegeCount = 1,
            Privileges = new LuidAndAttributes { Luid = luid, Attributes = 0x00000002 }
        };
        if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero))
        {
            ThrowLastError("AdjustTokenPrivileges failed");
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 0) throw new Win32Exception(error, "AdjustTokenPrivileges failed");
    }

    private static IntPtr CreateRestrictedPrimaryToken(IntPtr capabilitySid)
    {
        IntPtr baseToken = IntPtr.Zero;
        IntPtr groups = IntPtr.Zero;
        IntPtr worldSid = IntPtr.Zero;
        IntPtr restrictedSids = IntPtr.Zero;
        try
        {
            uint desiredAccess = TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustPrivileges |
                TokenAdjustDefault | TokenAdjustSessionId;
            if (!OpenProcessToken(GetCurrentProcess(), desiredAccess, out baseToken))
            {
                ThrowLastError("OpenProcessToken failed");
            }

            uint groupsSize = 0;
            GetTokenInformation(baseToken, TokenGroups, IntPtr.Zero, 0, out groupsSize);
            if (groupsSize == 0) ThrowLastError("GetTokenInformation size query failed");
            groups = Marshal.AllocHGlobal((int)groupsSize);
            if (!GetTokenInformation(baseToken, TokenGroups, groups, groupsSize, out groupsSize))
            {
                ThrowLastError("GetTokenInformation groups failed");
            }
            int groupCount = Marshal.ReadInt32(groups);
            int groupsOffset = IntPtr.Size == 8 ? 8 : 4;
            int entrySize = Marshal.SizeOf(typeof(SidAndAttributes));
            IntPtr logonSid = IntPtr.Zero;
            for (int index = 0; index < groupCount; index++)
            {
                IntPtr entryPointer = IntPtr.Add(groups, groupsOffset + index * entrySize);
                SidAndAttributes entry = (SidAndAttributes)Marshal.PtrToStructure(
                    entryPointer,
                    typeof(SidAndAttributes));
                if ((entry.Attributes & 0xC0000000) == 0xC0000000)
                {
                    logonSid = entry.Sid;
                    break;
                }
            }
            if (logonSid == IntPtr.Zero) throw new InvalidOperationException("Logon SID is missing from the token.");

            uint worldSidSize = 0;
            CreateWellKnownSid(WinWorldSid, IntPtr.Zero, IntPtr.Zero, ref worldSidSize);
            worldSid = Marshal.AllocHGlobal((int)worldSidSize);
            if (!CreateWellKnownSid(WinWorldSid, IntPtr.Zero, worldSid, ref worldSidSize))
            {
                ThrowLastError("CreateWellKnownSid failed");
            }

            SidAndAttributes[] restrictions = new SidAndAttributes[]
            {
                new SidAndAttributes { Sid = capabilitySid, Attributes = 0 },
                new SidAndAttributes { Sid = logonSid, Attributes = 0 },
                new SidAndAttributes { Sid = worldSid, Attributes = 0 },
            };
            restrictedSids = Marshal.AllocHGlobal(entrySize * restrictions.Length);
            for (int index = 0; index < restrictions.Length; index++)
            {
                Marshal.StructureToPtr(restrictions[index], IntPtr.Add(restrictedSids, index * entrySize), false);
            }

            IntPtr restrictedToken;
            uint flags = DisableMaxPrivilege | LuaToken | WriteRestricted;
            if (!CreateRestrictedToken(
                    baseToken,
                    flags,
                    0,
                    IntPtr.Zero,
                    0,
                    IntPtr.Zero,
                    (uint)restrictions.Length,
                    restrictedSids,
                    out restrictedToken))
            {
                ThrowLastError("CreateRestrictedToken failed");
            }
            SetPermissiveDefaultDacl(restrictedToken, new IntPtr[] { logonSid, worldSid, capabilitySid });
            EnableChangeNotifyPrivilege(restrictedToken);
            return restrictedToken;
        }
        finally
        {
            if (restrictedSids != IntPtr.Zero) Marshal.FreeHGlobal(restrictedSids);
            if (worldSid != IntPtr.Zero) Marshal.FreeHGlobal(worldSid);
            if (groups != IntPtr.Zero) Marshal.FreeHGlobal(groups);
            if (baseToken != IntPtr.Zero) CloseHandle(baseToken);
        }
    }

    public static int Run(string command, string[] arguments, string currentDirectory, string capabilitySid)
    {
        IntPtr sid = IntPtr.Zero;
        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        bool processCreated = false;
        try
        {
            if (!ConvertStringSidToSid(capabilitySid, out sid))
            {
                ThrowLastError("ConvertStringSidToSid failed");
            }
            restrictedToken = CreateRestrictedPrimaryToken(sid);
            job = CreateLimitedJob();
            StartupInfo startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
            startup.dwFlags = StartfUseStdHandles;
            startup.hStdInput = GetStdHandle(StdInputHandle);
            startup.hStdOutput = GetStdHandle(StdOutputHandle);
            startup.hStdError = GetStdHandle(StdErrorHandle);
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(command, arguments));
            if (!CreateProcessAsUserW(
                    restrictedToken,
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CreateSuspended,
                    IntPtr.Zero,
                    currentDirectory,
                    ref startup,
                    out process))
            {
                ThrowLastError("CreateProcessAsUserW restricted-token launch failed");
            }
            processCreated = true;
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                ThrowLastError("AssignProcessToJobObject failed");
            }
            if (ResumeThread(process.hThread) == 0xFFFFFFFF)
            {
                ThrowLastError("ResumeThread failed");
            }
            uint waitResult = WaitForSingleObject(process.hProcess, Infinite);
            if (waitResult != 0)
            {
                ThrowLastError("WaitForSingleObject failed");
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
            {
                ThrowLastError("GetExitCodeProcess failed");
            }
            return unchecked((int)exitCode);
        }
        catch
        {
            if (processCreated && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
            throw;
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            if (sid != IntPtr.Zero) LocalFree(sid);
        }
    }
}
'@

$nativeAssembly = "$PSCommandPath.native.dll"
if ($Probe) {
    if (Test-Path -LiteralPath $nativeAssembly) {
        Remove-Item -LiteralPath $nativeAssembly -Force
    }
    Add-Type -TypeDefinition $nativeSource -Language CSharp -OutputAssembly $nativeAssembly
    exit 0
}
if (-not (Test-Path -LiteralPath $nativeAssembly -PathType Leaf)) {
    throw "Sandbox native launcher assembly is missing."
}
Add-Type -Path $nativeAssembly

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $normalizedCandidate = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    return $normalizedCandidate.Equals($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $normalizedCandidate.StartsWith($normalizedRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Set-SandboxAcl {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Identity,
        [Parameter(Mandatory = $true)][System.Security.AccessControl.FileSystemRights]$Rights,
        [Parameter(Mandatory = $true)][System.Security.AccessControl.AccessControlType]$Type,
        [Parameter(Mandatory = $true)][bool]$Required,
        [bool]$Inherit = $true
    )

    if (-not (Test-Path -LiteralPath $LiteralPath)) {
        if ($Required) { throw "Sandbox ACL path does not exist: $LiteralPath" }
        return
    }
    try {
        $item = Get-Item -LiteralPath $LiteralPath -Force
        $inheritance = if ($item.PSIsContainer -and $Inherit) {
            [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        } else {
            [System.Security.AccessControl.InheritanceFlags]::None
        }
        $acl = Get-Acl -LiteralPath $LiteralPath
        foreach ($existing in @($acl.Access)) {
            if ($existing.IdentityReference.Value -eq $Identity.Value -and $existing.AccessControlType -eq $Type) {
                $hasRights = ([int64]$existing.FileSystemRights -band [int64]$Rights) -eq [int64]$Rights
                $hasInheritance = -not $Inherit -or
                    (($existing.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and
                    ($existing.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0)
                if ($hasRights -and $hasInheritance) { return }
                [void]$acl.RemoveAccessRuleSpecific($existing)
            }
        }
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $Identity,
            $Rights,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            $Type
        )
        [void]$acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $LiteralPath -AclObject $acl
    } catch {
        if ($Required) { throw }
    }
}

try {
    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Request))
    $launch = $json | ConvertFrom-Json
} catch {
    throw "Invalid sandbox launcher request: $($_.Exception.Message)"
}

if ($launch.version -ne 1) { throw "Unsupported sandbox launcher request version." }
$command = [System.IO.Path]::GetFullPath([string]$launch.command)
$cwd = [System.IO.Path]::GetFullPath([string]$launch.cwd)
$workspaceRoot = [System.IO.Path]::GetFullPath([string]$launch.workspaceRoot)
$tempRoot = [System.IO.Path]::GetFullPath([string]$launch.tempRoot)
if (-not (Test-Path -LiteralPath $command -PathType Leaf)) { throw "Sandbox executable does not exist: $command" }
if (-not (Test-PathInside -Root $workspaceRoot -Candidate $cwd) -and
    -not (Test-PathInside -Root $tempRoot -Candidate $cwd)) {
    throw "Sandbox working directory is outside allowed roots."
}

$profileSeed = "$workspaceRoot|$([bool]$launch.readOnly)"
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try {
    $profileHash = $hashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($profileSeed))
} finally {
    $hashAlgorithm.Dispose()
}
$sidParts = 0..3 | ForEach-Object { [System.BitConverter]::ToUInt32($profileHash, $_ * 4) }
$sandboxSid = "S-1-5-21-$($sidParts -join '-')"
$identity = [System.Security.Principal.SecurityIdentifier]::new($sandboxSid)
$readRights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
    [System.Security.AccessControl.FileSystemRights]::Synchronize
$modifyRights = [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::Synchronize
$denyWriteRights = [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership

$workspaceRights = if ([bool]$launch.readOnly) { $readRights } else { $modifyRights }
Set-SandboxAcl -LiteralPath $workspaceRoot -Identity $identity -Rights $workspaceRights -Type Allow -Required $true
Set-SandboxAcl -LiteralPath $tempRoot -Identity $identity -Rights $modifyRights -Type Allow -Required $true
foreach ($protectedPath in @($launch.protectedWritePaths)) {
    $resolvedProtectedPath = [System.IO.Path]::GetFullPath([string]$protectedPath)
    if (-not (Test-PathInside -Root $workspaceRoot -Candidate $resolvedProtectedPath)) {
        throw "Protected write path is outside the workspace."
    }
    Set-SandboxAcl -LiteralPath $resolvedProtectedPath -Identity $identity -Rights $denyWriteRights -Type Deny -Required $false
}
$arguments = @($launch.args | ForEach-Object { [string]$_ })
$exitCode = [PiSandboxNative]::Run($command, $arguments, $cwd, $sandboxSid)
exit $exitCode
