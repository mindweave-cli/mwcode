# Puts the CLI's folder first on PATH, or takes it off. Run by the installer and the uninstaller.
# Reads and writes the registry value as it is stored (REG_EXPAND_SZ, %VARS% unexpanded), so the
# rest of PATH comes back exactly as it was. First on PATH means an older CLI installed with npm
# is not the one that runs.
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir,
  [ValidateSet('user', 'machine')][string]$Scope = 'user'
)
$ErrorActionPreference = 'Stop'

$key = if ($Scope -eq 'machine') {
  [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
} else {
  [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
}
$old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$want = $Dir.TrimEnd('\')
# Only our own entry is touched: everything else, empty slots included, stays exactly as it was.
$rest = if ($old -eq '') { @() } else { @($old -split ';' | Where-Object { $_.TrimEnd('\') -ine $want }) }
$parts = if ($Action -eq 'add') { @($want) + $rest } else { $rest }
$new = $parts -join ';'
if ($new -ne $old) {
  $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
}
$key.Close()

# Tell open programs (Explorer, new terminals) that the environment changed.
Add-Type -Namespace MwSetup -Name Env -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
$r = [System.UIntPtr]::Zero
[void][MwSetup.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
