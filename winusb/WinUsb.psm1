Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-UsbProfile {
    param([string]$Model)
    if ($Model -notmatch '^[a-z0-9][a-z0-9-]*$') { throw 'モデル名が不正です。' }
    $path = Join-Path $PSScriptRoot "models/$Model.json"
    $profile = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($profile.schemaVersion -ne 1 -or
        $profile.vendorId -notmatch '^[0-9a-fA-F]{4}$' -or
        $profile.productId -notmatch '^[0-9a-fA-F]{4}$' -or
        ($profile.usbInterface -isnot [int] -and $profile.usbInterface -isnot [long]) -or
        $profile.usbInterface -lt 0 -or $profile.usbInterface -gt 255 -or
        [string]::IsNullOrWhiteSpace($profile.name) -or
        @($profile.allowedServices).Count -eq 0) {
        throw '機種プロファイルの形式が不正です。'
    }
    return $profile
}

function Assert-UsbWindows {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'この操作はWindowsで実行してください。'
    }
}

function Assert-UsbAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Installは管理者として起動したPowerShellで実行してください。'
    }
}

function Get-UsbProperty {
    param([object[]]$Properties, [string]$Key)
    foreach ($property in $Properties) {
        if ($property.KeyName -eq $Key) { return $property.Data }
    }
}

function Get-UsbSnapshot {
    param($Profile)
    $prefix = 'USB\VID_{0}&PID_{1}' -f $Profile.vendorId, $Profile.productId
    foreach ($device in @(Get-PnpDevice -PresentOnly -ErrorAction Stop)) {
        if (-not $device.InstanceId.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
        # 同じVID/PIDの親と子を記録し、選択はハードウェアIDで厳密に行う。
        Get-UsbDeviceInfo $device
    }
}

function Get-UsbDeviceInfo {
    param($Device)
    $properties = @(Get-PnpDeviceProperty -InstanceId $Device.InstanceId -ErrorAction Stop)
    [pscustomobject]@{
        InstanceId = $Device.InstanceId
        FriendlyName = $Device.FriendlyName
        BusReportedName = [string](Get-UsbProperty $properties 'DEVPKEY_Device_BusReportedDeviceDesc')
        HardwareIds = @(Get-UsbProperty $properties 'DEVPKEY_Device_HardwareIds')
        CompatibleIds = @(Get-UsbProperty $properties 'DEVPKEY_Device_CompatibleIds')
        Service = [string](Get-UsbProperty $properties 'DEVPKEY_Device_Service')
        DriverInfPath = [string](Get-UsbProperty $properties 'DEVPKEY_Device_DriverInfPath')
        DriverProvider = [string](Get-UsbProperty $properties 'DEVPKEY_Device_DriverProvider')
        ProblemCode = Get-UsbProperty $properties 'DEVPKEY_Device_ProblemCode'
    }
}

function ConvertTo-UsbCandidate {
    param($Device)
    if ($Device.InstanceId -notmatch '^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(?:&MI_([0-9A-F]{2}))?\\') { return }
    $vendorId = $Matches[1].ToUpperInvariant()
    $productId = $Matches[2].ToUpperInvariant()
    $interfaceNumber = $null
    if ($Matches[3]) { $interfaceNumber = [Convert]::ToInt32($Matches[3], 16) }
    $name = $Device.BusReportedName
    if ([string]::IsNullOrWhiteSpace($name)) { $name = $Device.FriendlyName }
    if ([string]::IsNullOrWhiteSpace($name)) { $name = $Device.InstanceId }
    $printerClass = @($Device.CompatibleIds | Where-Object { $_ -match '^USB\\Class_07(?:&|$)' }).Count -gt 0
    $printerHint = $printerClass -or $Device.Service -ieq 'usbprint' -or $name -match 'printer|printing|receipt|プリンタ|印刷'
    $unsupported = $Device.Service -match '^(usbccgp|usbser|HidUsb|USBSTOR|UASPStor|USBHUB3?|usbhub)$' -or
        @($Device.CompatibleIds | Where-Object { $_ -match '^USB\\Class_(02|03|08|09)(?:&|$)' }).Count -gt 0
    [pscustomobject]@{
        Name = $name
        VendorId = $vendorId
        ProductId = $productId
        UsbInterface = $interfaceNumber
        Service = $Device.Service
        IsPrinterCandidate = $printerHint -and -not $unsupported
        CanDraftProfile = -not $unsupported -and -not [string]::IsNullOrWhiteSpace($Device.Service)
        Device = $Device
    }
}

function Get-UsbDiscoveryDevices {
    foreach ($device in @(Get-PnpDevice -PresentOnly -ErrorAction Stop)) {
        if ($device.InstanceId -notmatch '^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}') { continue }
        try {
            ConvertTo-UsbCandidate (Get-UsbDeviceInfo $device)
        } catch {
            Write-Warning "情報を取得できない機器をスキップしました: $($device.InstanceId): $_"
        }
    }
}

function New-UsbDraftProfile {
    param($Candidate, $InterfaceNumber)
    if (-not $Candidate.CanDraftProfile) { throw 'このUSB動作モードではWinUSB用ひな形を作成できません。' }
    [ordered]@{
        schemaVersion = 1
        name = "$($Candidate.Name) WebUSB"
        vendorId = $Candidate.VendorId
        productId = $Candidate.ProductId
        usbInterface = $InterfaceNumber
        # 観測したサービスを候補として記録する。導入前に利用者が内容を確認する。
        allowedServices = @(@($Candidate.Service, 'WinUSB') | Select-Object -Unique)
    }
}

function Find-WebUsbPrinter {
    [CmdletBinding()]
    param([switch]$ShowAll, [string]$OutputDirectory = (Join-Path $PSScriptRoot 'state/discovery'))
    Assert-UsbWindows
    while ($true) {
        $devices = @(Get-UsbDiscoveryDevices | Sort-Object @{ Expression = 'IsPrinterCandidate'; Descending = $true }, Name, @{ Expression = { $_.Device.InstanceId } })
        $visible = @($devices | Where-Object { $ShowAll -or $_.IsPrinterCandidate })
        if ($visible.Count -eq 0 -and $devices.Count -gt 0) {
            Write-Host 'プリンター候補が見つからないため、他のUSB機器も表示します。'
            $visible = $devices
        }
        if ($devices.Count -eq 0) { Write-Host '対象のUSB機器が見つかりません。接続後に再読込してください。' }
        for ($index = 0; $index -lt $visible.Count; $index++) {
            $item = $visible[$index]
            $mi = '未確認'
            if ($null -ne $item.UsbInterface) { $mi = [string]$item.UsbInterface }
            Write-Host ("[{0}] {1} | {2}:{3} | Interface={4} | Service={5}" -f ($index + 1), $item.Name, $item.VendorId, $item.ProductId, $mi, $item.Service)
            Write-Host "    $($item.Device.InstanceId)"
        }
        $answer = Read-Host '番号を選択（a:全USB機器、r:再読込、q:終了）'
        if ($answer -ieq 'q') { return }
        if ($answer -ieq 'a') { $ShowAll = [switch]$true; continue }
        if ($answer -ieq 'r') { continue }
        $number = 0
        if (-not [int]::TryParse($answer, [ref]$number) -or $number -lt 1 -or $number -gt $visible.Count) {
            Write-Host '表示された番号を入力してください。'
            continue
        }
        $selected = $visible[$number - 1]
        Write-Host '選択したUSB機器の調査結果:'
        $selected.Device | Format-List | Out-Host
        Write-Host "VID=$($selected.VendorId) / PID=$($selected.ProductId) / 表示名候補=$($selected.Name)"
        if ($null -eq $selected.UsbInterface) {
            Write-Host 'MIのない機器ではUSBインターフェース番号をPnP情報だけから確定できません。'
        } else { Write-Host "USBインターフェース番号（MIから取得）: $($selected.UsbInterface)" }
        if ((Read-Host '調査結果と設定ひな形を保存しますか？（y/N）') -ine 'y') { return $selected }

        $interfaceNumber = $selected.UsbInterface
        if ($selected.CanDraftProfile -and $null -eq $interfaceNumber) {
            while ($true) {
                $answer = Read-Host '確認済みのUSBインターフェース番号（0〜255、未確認ならEnter）'
                if ([string]::IsNullOrWhiteSpace($answer)) { break }
                $parsed = 0
                if ([int]::TryParse($answer, [ref]$parsed) -and $parsed -ge 0 -and $parsed -le 255) {
                    $interfaceNumber = $parsed
                    break
                }
                Write-Host '0〜255の整数か、未確認ならEnterを入力してください。'
            }
        }
        $directory = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ([guid]::NewGuid().ToString())
        $null = New-Item -ItemType Directory -Path $directory
        $selected | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'device.json') -Encoding UTF8
        if ($selected.CanDraftProfile) {
            New-UsbDraftProfile $selected $interfaceNumber | ConvertTo-Json -Depth 4 |
                Set-Content -LiteralPath (Join-Path $directory 'profile.draft.json') -Encoding UTF8
            Write-Host '設定ひな形を保存しました。usbInterfaceとallowedServicesを確認してからmodelsへ配置してください。'
        } else {
            Write-Host '親デバイス・仮想COM等やサービス不明の機器は、調査結果だけを保存しました。'
        }
        Write-Host "保存先: $directory"
        return $selected
    }
}

function Select-UsbTarget {
    param($Profile, [object[]]$Devices)
    $baseId = 'USB\VID_{0}&PID_{1}' -f $Profile.vendorId, $Profile.productId
    $childId = '{0}&MI_{1:X2}' -f $baseId, $Profile.usbInterface
    $targets = @($Devices | Where-Object {
        ($_.HardwareIds -contains $childId) -or
        (($_.HardwareIds -contains $baseId) -and $_.Service -ine 'usbccgp')
    })
    if ($targets.Count -ne 1) {
        throw "対象を1台に特定できません（候補数: $($targets.Count)）。接続台数とInspectの結果を確認してください。"
    }
    $target = $targets[0]
    if ($Profile.allowedServices -notcontains $target.Service) {
        throw "想定外のドライバーです: $($target.Service)。プロファイルと現在の設定を確認してください。"
    }
    return $target
}

function Get-UsbInterfaceGuids {
    param([string]$InstanceId)
    $path = "Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Enum\$InstanceId\Device Parameters"
    # WinUSBだけではアプリが列挙できないため、公開GUIDも確認する。
    $parameters = Get-ItemProperty -LiteralPath $path -ErrorAction Stop
    foreach ($name in @('DeviceInterfaceGUIDs', 'DeviceInterfaceGUID')) {
        $property = $parameters.PSObject.Properties[$name]
        if ($null -ne $property) { $property.Value }
    }
}

function Assert-UsbReady {
    param($Target)
    if ($Target.Service -ine 'WinUSB' -or $Target.ProblemCode -ne 0) {
        throw "WinUSBが正常に割り当てられていません（Service=$($Target.Service), ProblemCode=$($Target.ProblemCode)）。"
    }
    $valid = @()
    foreach ($value in @(Get-UsbInterfaceGuids $Target.InstanceId)) {
        $guid = [guid]::Empty
        if ([guid]::TryParse([string]$value, [ref]$guid) -and $guid -ne [guid]::Empty) { $valid += $value }
    }
    if ($valid.Count -eq 0) { throw 'DeviceInterfaceGUIDsがありません。WinUSBパッケージを確認してください。' }
}

function New-UsbInstallerArguments {
    param($Profile, $Target, [string]$Destination)
    $arguments = @('--vid', "0x$($Profile.vendorId)", '--pid', "0x$($Profile.productId)",
        '--type', '0', '--name', $Profile.name, '--inf', 'webusb.inf', '--dest', $Destination)
    $childId = 'USB\VID_{0}&PID_{1}&MI_{2:X2}' -f $Profile.vendorId, $Profile.productId, $Profile.usbInterface
    # Interface 0でも、単一USB機器には--iidを付けない。
    if ($Target.HardwareIds -contains $childId) { $arguments += @('--iid', [string]$Profile.usbInterface) }
    return $arguments
}

function Invoke-UsbInstaller {
    param([string]$Path, [string[]]$Arguments)
    # 引数を配列のまま渡し、コマンド文字列として評価しない。
    & $Path @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "wdi-simpleが失敗しました（終了コード: $LASTEXITCODE）。自動再試行しません。" }
}

function Backup-UsbDriver {
    param($Target, [string]$RunDirectory)
    # Windows標準INFはOSが持つため、追加パッケージだけをエクスポートする。
    if ($Target.DriverInfPath -notmatch '^oem[0-9]+\.inf$') { return }
    $destination = Join-Path $RunDirectory 'original-driver'
    $null = New-Item -ItemType Directory -Path $destination
    & "$env:SystemRoot\System32\pnputil.exe" /export-driver $Target.DriverInfPath $destination | Out-Host
    if ($LASTEXITCODE -ne 0) { throw '元のドライバーを保存できませんでした。変更を停止しました。' }
}

function Invoke-WebUsbSetup {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Model,
        [ValidateSet('Inspect', 'Install', 'Verify')][string]$Action = 'Inspect',
        [string]$InstallerPath,
        [string]$StateDirectory = (Join-Path $PSScriptRoot 'state')
    )
    Assert-UsbWindows
    $profile = Read-UsbProfile $Model
    $devices = @(Get-UsbSnapshot $profile)
    if ($Action -eq 'Inspect') {
        # 不一致や複数接続でも診断情報は参照できる。
        return $devices
    }
    $target = Select-UsbTarget $profile $devices
    if ($Action -eq 'Verify' -or $target.Service -ieq 'WinUSB') {
        Assert-UsbReady $target
        Write-Host 'WinUSBと公開GUIDを確認しました。ブラウザからのUSB許可・印刷確認は別途必要です。'
        return $target
    }

    $stateRoot = [IO.Path]::GetFullPath($StateDirectory)
    $preview = New-UsbInstallerArguments $profile $target (Join-Path $stateRoot '(run-id)/driver')
    Write-Host "対象: $($target.InstanceId) / 現在: $($target.Service) / INF: $($target.DriverInfPath)"
    Write-Host "wdi-simple引数: $($preview -join ' ')"
    if (-not $PSCmdlet.ShouldProcess($target.InstanceId, '通常のプリンター印刷からWinUSBへ変更')) { return }

    Assert-UsbAdministrator
    if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
        throw 'Installには、別途用意したwdi-simple.exeを-InstallerPathで指定してください。'
    }
    $installer = (Get-Item -LiteralPath $InstallerPath -ErrorAction Stop).FullName
    if ([IO.Path]::GetFileName($installer) -ine 'wdi-simple.exe') {
        throw 'wdi-simple.exeを指定してください。Zadigの実行ファイルはCLIとして利用できません。'
    }
    # 実行前に再列挙し、抜き差しや複数接続による対象の変化を検出する。
    $current = Select-UsbTarget $profile @(Get-UsbSnapshot $profile)
    if ($current.InstanceId -ine $target.InstanceId -or $current.Service -ine $target.Service -or
        $current.DriverInfPath -ine $target.DriverInfPath) { throw '対象が変化しました。Inspectからやり直してください。' }

    $runDirectory = Join-Path $stateRoot (Get-Date -Format 'yyyyMMdd-HHmmss-fffffff')
    $null = New-Item -ItemType Directory -Path $runDirectory -ErrorAction Stop
    $record = [ordered]@{
        model = $Model
        profile = $profile
        before = $devices
        installer = $installer
        installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
        createdAt = [DateTime]::UtcNow.ToString('o')
    }
    $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory 'before.json') -Encoding UTF8
    Write-Host "変更前の記録: $runDirectory"
    Backup-UsbDriver $current $runDirectory
    $arguments = New-UsbInstallerArguments $profile $current (Join-Path $runDirectory 'driver')
    Invoke-UsbInstaller $installer $arguments

    # インストール終了コードだけでは成功とみなさず、元の個体を再確認する。
    $after = @(Get-UsbSnapshot $profile)
    $after | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory 'after.json') -Encoding UTF8
    $installed = Select-UsbTarget $profile $after
    if ($installed.InstanceId -ine $target.InstanceId) { throw '変更後の機器が一致しません。記録と接続を確認してください。' }
    Assert-UsbReady $installed
    Write-Host 'WinUSBへの変更を確認しました。再起動・抜き差しが必要な場合は、その後Verifyを実行してください。'
    return $installed
}

Export-ModuleMember -Function Invoke-WebUsbSetup, Find-WebUsbPrinter
