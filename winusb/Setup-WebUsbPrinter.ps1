#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]*$')]
    [string]$Model,
    [ValidateSet('Inspect', 'Install', 'Verify')]
    [string]$Action = 'Inspect',
    [string]$InstallerPath,
    [string]$StateDirectory = (Join-Path $PSScriptRoot 'state')
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WinUsb.psm1') -Force
$options = @{
    Model = $Model
    Action = $Action
    InstallerPath = $InstallerPath
    StateDirectory = $StateDirectory
}
if ($PSBoundParameters.ContainsKey('Confirm')) { $options.Confirm = $PSBoundParameters['Confirm'] }
Invoke-WebUsbSetup @options -WhatIf:$WhatIfPreference
