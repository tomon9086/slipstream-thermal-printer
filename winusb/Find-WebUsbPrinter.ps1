#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$ShowAll,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'state/discovery')
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WinUsb.psm1') -Force
Find-WebUsbPrinter -ShowAll:$ShowAll -OutputDirectory $OutputDirectory
