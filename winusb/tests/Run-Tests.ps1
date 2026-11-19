#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot '../WinUsb.psm1') -Force -PassThru

# モジュール内のOS境界だけを置き換え、USB操作や外部EXEの実行は行わない。
& $module {
    $script:passed = 0
    function Assert-True($Condition, [string]$Message = '条件を満たしていません。') {
        if (-not $Condition) { throw $Message }
    }
    function Assert-Throws([scriptblock]$Body, [string]$Pattern) {
        $caught = $null
        try { & $Body | Out-Null } catch { $caught = $_ }
        Assert-True ($null -ne $caught) '例外が発生しませんでした。'
        Assert-True ($caught.Exception.Message -match $Pattern) "想定外の例外: $caught"
    }
    function Test-Case([string]$Description, [scriptblock]$Body) {
        & $Body
        $script:passed++
        Write-Host "PASS: $Description"
    }
    function New-Device([string]$Id, [string]$Service = 'usbprint', [string]$Serial = 'unit1') {
        [pscustomobject]@{
            InstanceId = "$Id\$Serial"
            FriendlyName = 'テスト用プリンター'
            HardwareIds = @($Id)
            Service = $Service
            DriverInfPath = 'oem42.inf'
            ProblemCode = 0
        }
    }
    $profile = Read-UsbProfile 'rp-e11'
    $baseId = 'USB\VID_0619&PID_0123'
    $single = New-Device $baseId
    $child = New-Device "$baseId&MI_00"
    $parent = New-Device $baseId 'usbccgp'

    Test-Case 'モデル名によるディレクトリ外参照を拒否する' {
        Assert-Throws { Read-UsbProfile '../other' } 'モデル名'
    }
    Test-Case '単一機器はInterface 0でもMIを指定しない' {
        $target = Select-UsbTarget $profile @($single)
        $arguments = @(New-UsbInstallerArguments $profile $target 'C:\出力 先')
        Assert-True ($arguments -notcontains '--iid')
        Assert-True ($arguments -contains '0x0619')
        Assert-True ($arguments -contains '0x0123')
        Assert-True ($arguments -contains 'C:\出力 先')
        Assert-True ($arguments -contains 'SII RP-E11 WebUSB')
    }
    Test-Case '複合機器では親を除外し対象のMIだけを選ぶ' {
        $other = New-Device "$baseId&MI_01"
        $target = Select-UsbTarget $profile @($parent, $child, $other)
        Assert-True ($target.InstanceId -eq $child.InstanceId)
        $arguments = @(New-UsbInstallerArguments $profile $target 'C:\driver')
        $index = [array]::IndexOf($arguments, '--iid')
        Assert-True ($index -ge 0 -and $arguments[$index + 1] -eq '0')
    }
    Test-Case '未接続・複合親のみ・別PIDは変更対象にしない' {
        Assert-Throws { Select-UsbTarget $profile @() } '候補数: 0'
        Assert-Throws { Select-UsbTarget $profile @($parent) } '候補数: 0'
        Assert-Throws { Select-UsbTarget $profile @((New-Device 'USB\VID_0619&PID_0124')) } '候補数: 0'
    }
    Test-Case '同じIDの複数台接続を拒否する' {
        Assert-Throws { Select-UsbTarget $profile @($single, (New-Device $baseId 'usbprint' 'unit2')) } '候補数: 2'
        Assert-Throws { Select-UsbTarget $profile @($single, $child) } '候補数: 2'
    }
    Test-Case '想定外のメーカー製ドライバーを上書きしない' {
        Assert-Throws { Select-UsbTarget $profile @((New-Device $baseId 'vendorDriver')) } '想定外'
    }
    Test-Case '外部プロセスの失敗終了を成功として扱わない' {
        $hostPath = (Get-Process -Id $PID).Path
        Assert-Throws { Invoke-UsbInstaller $hostPath @('-NoProfile', '-Command', 'exit 7') } '終了コード: 7'
    }

    function New-DiscoveryDevice([string]$Id, [string]$Service = 'usbprint', [string]$Name = 'Receipt Printer', [string]$Serial = 'unit1') {
        $device = New-Device $Id $Service $Serial
        $device | Add-Member -NotePropertyName BusReportedName -NotePropertyValue $Name
        $device | Add-Member -NotePropertyName CompatibleIds -NotePropertyValue @('USB\Class_07&SubClass_01&Prot_02')
        return $device
    }
    Test-Case 'MIを16進数から復号し、MIなしの番号は推測しない' {
        $candidate = ConvertTo-UsbCandidate (New-DiscoveryDevice "$baseId&MI_0A")
        Assert-True ($candidate.UsbInterface -eq 10 -and $candidate.VendorId -eq '0619' -and $candidate.ProductId -eq '0123')
        $candidate = ConvertTo-UsbCandidate (New-DiscoveryDevice $baseId)
        Assert-True ($null -eq $candidate.UsbInterface -and $candidate.IsPrinterCandidate)
        $draft = New-UsbDraftProfile $candidate $null
        Assert-True ($null -eq $draft.usbInterface -and $draft.allowedServices -contains 'usbprint' -and $draft.allowedServices -contains 'WinUSB')
    }
    Test-Case 'USB以外の印刷キューは候補に混ぜない' {
        $candidate = ConvertTo-UsbCandidate (New-DiscoveryDevice 'USBPRINT\Printer')
        Assert-True ($null -eq $candidate)
    }
    Test-Case '名前がプリンターでも親・HID・仮想COMのひな形は生成しない' {
        foreach ($service in @('usbccgp', 'HidUsb', 'usbser', 'USBSTOR', 'USBHUB3', '')) {
            $candidate = ConvertTo-UsbCandidate (New-DiscoveryDevice $baseId $service)
            Assert-True (-not $candidate.CanDraftProfile)
            Assert-Throws { New-UsbDraftProfile $candidate 0 } 'ひな形'
        }
        $device = New-DiscoveryDevice $baseId 'vendorDriver'
        $device.CompatibleIds = @('USB\Class_03&SubClass_00')
        Assert-True (-not (ConvertTo-UsbCandidate $device).CanDraftProfile)
    }

    function Assert-UsbWindows {}
    function Assert-UsbAdministrator {
        if (-not $script:admin) { throw '管理者権限がありません。' }
    }
    function Get-UsbSnapshot {
        param($Profile)
        $script:snapshotCalls++
        if ($script:snapshotCalls -eq 2 -and $script:changed) {
            return @((New-Device $baseId 'usbprint' 'different-unit'))
        }
        if ($script:snapshotCalls -gt 2) { return $script:after }
        return $script:before
    }
    function Get-UsbInterfaceGuids { param($InstanceId); return $script:guids }
    function Get-UsbDiscoveryDevices {
        $script:discoveryCalls++
        return $script:discovery
    }
    function Read-Host {
        param([string]$Prompt)
        if ($script:answers.Count -eq 0) { throw "対話の入力が不足しています: $Prompt" }
        return $script:answers.Dequeue()
    }
    function Backup-UsbDriver {
        param($Target, [string]$RunDirectory)
        $script:backupCalls++
        if ($script:backupFails) { throw '元のドライバーを保存できませんでした。' }
    }
    function Invoke-UsbInstaller {
        param([string]$Path, [string[]]$Arguments)
        $script:installerCalls++
        $script:arguments = $Arguments
        if ($script:installerFails) { throw 'インストーラー失敗。' }
    }
    function Reset-State {
        $script:before = @($single)
        $script:after = @((New-Device $baseId 'WinUSB'))
        $script:snapshotCalls = 0
        $script:installerCalls = 0
        $script:installerFails = $false
        $script:backupCalls = 0
        $script:backupFails = $false
        $script:changed = $false
        $script:discoveryCalls = 0
        $script:discovery = @((ConvertTo-UsbCandidate (New-DiscoveryDevice $baseId)))
        $script:answers = New-Object 'System.Collections.Generic.Queue[string]'
        $script:admin = $true
        $script:guids = @('{594dee51-0a1d-4a77-bf5d-5e2eb808267c}')
    }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
    $null = New-Item -ItemType Directory -Path $temp
    $installer = Join-Path $temp 'wdi-simple.exe'
    Set-Content -LiteralPath $installer -Value '実行しないテスト用ファイル'
    try {
        Test-Case 'Inspectは対象選択せず複数台を表示する' {
            Reset-State
            $script:before = @($single, $parent, $child)
            $result = @(Invoke-WebUsbSetup -Model rp-e11)
            Assert-True ($result.Count -eq 3 -and $script:installerCalls -eq 0)
        }
        Test-Case 'WhatIfでは管理者・EXE不要でファイルも作成しない' {
            Reset-State
            $script:admin = $false
            $state = Join-Path $temp 'whatif'
            Invoke-WebUsbSetup -Model rp-e11 -Action Install -StateDirectory $state -WhatIf
            Assert-True ($script:installerCalls -eq 0 -and $script:backupCalls -eq 0 -and -not (Test-Path $state))
        }
        Test-Case '管理者権限なしでは変更しない' {
            Reset-State
            $script:admin = $false
            Assert-Throws { Invoke-WebUsbSetup -Model rp-e11 -Action Install -InstallerPath $installer } '管理者'
            Assert-True ($script:installerCalls -eq 0)
        }
        Test-Case 'インストーラー未指定やZadigの指定を拒否する' {
            Reset-State
            Assert-Throws { Invoke-WebUsbSetup -Model rp-e11 -Action Install } 'InstallerPath'
            $zadig = Join-Path $temp 'zadig.exe'
            Set-Content $zadig 'テスト用'
            Assert-Throws { Invoke-WebUsbSetup -Model rp-e11 -Action Install -InstallerPath $zadig } 'CLI'
            Assert-True ($script:installerCalls -eq 0)
        }
        Test-Case '既存WinUSBは再導入せずGUIDを検証する' {
            Reset-State
            $script:before = $script:after
            Invoke-WebUsbSetup -Model rp-e11 -Action Install | Out-Null
            Assert-True ($script:installerCalls -eq 0)
        }
        Test-Case 'GUID欠落・不正値・デバイス問題コードを検出する' {
            Reset-State
            $ready = $script:after[0]
            $script:guids = @('invalid')
            Assert-Throws { Assert-UsbReady $ready } 'GUID'
            $script:guids = @()
            Assert-Throws { Assert-UsbReady $ready } 'GUID'
            $ready.ProblemCode = 10
            Assert-Throws { Assert-UsbReady $ready } 'ProblemCode=10'
        }
        Test-Case 'Verifyは通常ドライバーのままなら失敗する' {
            Reset-State
            Assert-Throws { Invoke-WebUsbSetup -Model rp-e11 -Action Verify } '正常に割り当て'
        }
        Test-Case '変更前記録を残して1回だけ導入し変更後を検証する' {
            Reset-State
            $state = Join-Path $temp 'install with spaces'
            Invoke-WebUsbSetup -Model rp-e11 -Action Install -InstallerPath $installer -StateDirectory $state | Out-Null
            Assert-True ($script:installerCalls -eq 1 -and $script:backupCalls -eq 1 -and $script:arguments -notcontains '--iid')
            $record = Get-ChildItem $state -Filter before.json -Recurse | Get-Content -Raw | ConvertFrom-Json
            Assert-True ($record.before[0].DriverInfPath -eq 'oem42.inf')
            Assert-True ($record.installerSha256 -eq (Get-FileHash $installer).Hash)
            Assert-True (@(Get-ChildItem $state -Filter after.json -Recurse).Count -eq 1)
        }
        Test-Case '実行直前に個体が変化したら変更しない' {
            Reset-State
            $script:changed = $true
            Assert-Throws {
                Invoke-WebUsbSetup -Model rp-e11 -Action Install -InstallerPath $installer -StateDirectory (Join-Path $temp 'changed')
            } '対象が変化'
            Assert-True ($script:installerCalls -eq 0)
        }
        Test-Case 'バックアップ失敗時は導入を開始しない' {
            Reset-State
            $script:backupFails = $true
            Assert-Throws {
                Invoke-WebUsbSetup -Model rp-e11 -Action Install -InstallerPath $installer -StateDirectory (Join-Path $temp 'backup-failed')
            } '元のドライバー'
            Assert-True ($script:installerCalls -eq 0)
        }
        Test-Case 'インストーラー成功でもWinUSB未適用なら失敗する' {
            Reset-State
            $script:after = @($single)
            Assert-Throws {
                Invoke-WebUsbSetup -Model rp-e11 -Action Install -InstallerPath $installer -StateDirectory (Join-Path $temp 'not-applied')
            } '正常に割り当て'
            Assert-True ($script:installerCalls -eq 1)
        }
        Test-Case '導入失敗時も変更前記録を保持し自動再試行しない' {
            Reset-State
            $script:installerFails = $true
            $state = Join-Path $temp 'failed'
            Assert-Throws {
                Invoke-WebUsbSetup -Model rp-e11 -Action Install -InstallerPath $installer -StateDirectory $state
            } 'インストーラー失敗'
            Assert-True ($script:installerCalls -eq 1)
            Assert-True (@(Get-ChildItem $state -Filter before.json -Recurse).Count -eq 1)
        }
        Test-Case '候補選択では範囲外入力を受け付けず保存を断ればファイルを作らない' {
            Reset-State
            foreach ($answer in @('invalid', '999', '1', 'n')) { $script:answers.Enqueue($answer) }
            $state = Join-Path $temp 'discovery-no-save'
            $result = Find-WebUsbPrinter -OutputDirectory $state
            Assert-True ($result.VendorId -eq '0619' -and -not (Test-Path $state))
            Assert-True ($script:installerCalls -eq 0 -and $script:backupCalls -eq 0)
        }
        Test-Case '未接続でも対話を中断できる' {
            Reset-State
            $script:discovery = @()
            $script:answers.Enqueue('q')
            Assert-True ($null -eq (Find-WebUsbPrinter))
        }
        Test-Case '全USB表示と再読込によりプリンター候補以外も調査できる' {
            Reset-State
            $other = New-DiscoveryDevice 'USB\VID_1111&PID_2222' 'vendorDriver' 'Z Other Device'
            $other.CompatibleIds = @()
            $script:discovery += ConvertTo-UsbCandidate $other
            foreach ($answer in @('a', 'r', '2', 'n')) { $script:answers.Enqueue($answer) }
            $result = Find-WebUsbPrinter
            Assert-True ($result.VendorId -eq '1111' -and $script:discoveryCalls -eq 3)
        }
        Test-Case '同型機でも個体を番号で区別して選べる' {
            Reset-State
            $script:discovery += ConvertTo-UsbCandidate (New-DiscoveryDevice $baseId 'usbprint' 'Receipt Printer' 'unit2')
            foreach ($answer in @('2', 'n')) { $script:answers.Enqueue($answer) }
            $result = Find-WebUsbPrinter
            Assert-True ($result.Device.InstanceId -eq "$baseId\unit2")
        }
        Test-Case 'MI付き機器は追加入力なしで観測した番号のひな形を保存する' {
            Reset-State
            $script:discovery = @((ConvertTo-UsbCandidate (New-DiscoveryDevice "$baseId&MI_0A")))
            foreach ($answer in @('1', 'y')) { $script:answers.Enqueue($answer) }
            $state = Join-Path $temp 'discovery-mi'
            Find-WebUsbPrinter -OutputDirectory $state | Out-Null
            $draft = Get-ChildItem $state -Filter profile.draft.json -Recurse | Get-Content -Raw | ConvertFrom-Json
            Assert-True ($draft.usbInterface -eq 10 -and $draft.allowedServices -contains 'WinUSB')
            Assert-True (@(Get-ChildItem $state -Filter device.json -Recurse).Count -eq 1)
            Assert-True ($script:installerCalls -eq 0 -and $script:backupCalls -eq 0)
        }
        Test-Case 'MIなしで未確認のまま保存しても番号0を自動設定しない' {
            Reset-State
            foreach ($answer in @('1', 'y', '')) { $script:answers.Enqueue($answer) }
            $state = Join-Path $temp 'discovery-unknown'
            Find-WebUsbPrinter -OutputDirectory $state | Out-Null
            $draft = Get-ChildItem $state -Filter profile.draft.json -Recurse | Get-Content -Raw | ConvertFrom-Json
            Assert-True ($null -eq $draft.usbInterface)
        }
        Test-Case '利用者が確認した番号は範囲を検証して保存する' {
            Reset-State
            foreach ($answer in @('1', 'y', '256', '-1', 'invalid', '0')) { $script:answers.Enqueue($answer) }
            $state = Join-Path $temp 'discovery-explicit'
            Find-WebUsbPrinter -OutputDirectory $state | Out-Null
            $draft = Get-ChildItem $state -Filter profile.draft.json -Recurse | Get-Content -Raw | ConvertFrom-Json
            Assert-True ($draft.usbInterface -eq 0)
        }
        Test-Case '複合親の選択では調査結果だけ保存し導入用ひな形を作らない' {
            Reset-State
            $script:discovery = @((ConvertTo-UsbCandidate (New-DiscoveryDevice $baseId 'usbccgp')))
            foreach ($answer in @('1', 'y')) { $script:answers.Enqueue($answer) }
            $state = Join-Path $temp 'discovery-parent'
            Find-WebUsbPrinter -ShowAll -OutputDirectory $state | Out-Null
            Assert-True (@(Get-ChildItem $state -Filter device.json -Recurse).Count -eq 1)
            Assert-True (@(Get-ChildItem $state -Filter profile.draft.json -Recurse).Count -eq 0)
        }
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
    Write-Host "$script:passed 件のテストに成功しました。"
}

# 失敗終了の検証で残った子プロセスの終了コードを呼び出し元へ伝播させない。
exit 0
