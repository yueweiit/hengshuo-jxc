[CmdletBinding()]
param(
    [ValidateSet('All', 'Backend', 'Frontend', 'Help')]
    [string]$Action = 'All'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverRoot = Join-Path $repoRoot 'jxc-server'
$webRoot = Join-Path $repoRoot 'jxc-web'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$Description
    )

    Write-Host "[test-env] $Description"
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "测试命令失败，退出码 $LASTEXITCODE：$Description"
    }
}

function Show-Help {
    @'
每次执行后端自动化测试都会由 Testcontainers 创建新的 PostgreSQL 和 MinIO 容器，
测试结束后由 Testcontainers 清理。该入口不连接开发数据库、Docker 验收数据库或生产数据库。

用法：
  .\jxc-server\scripts\test-env.ps1 -Action All
  .\jxc-server\scripts\test-env.ps1 -Action Backend
  .\jxc-server\scripts\test-env.ps1 -Action Frontend
'@
}

function Get-MavenCommand {
    $wrapper = Join-Path $serverRoot 'mvnw.cmd'
    if (Get-Command powershell.exe -ErrorAction SilentlyContinue) {
        return @{ File = $wrapper; Arguments = @('-Ppg-it', '-Dspring-boot.repackage.skip=true', 'verify') }
    }

    $maven = Get-Command mvn.cmd -ErrorAction SilentlyContinue
    if ($maven) {
        $version = (& $maven.Source '--version' | Select-String -Pattern '^Apache Maven ([0-9.]+)' | Select-Object -First 1).Matches.Groups[1].Value
        if ($version -ne '3.9.16') {
            throw "当前主机没有 powershell.exe，且 mvn.cmd 版本不是项目固定的 3.9.16（实际：$version）。"
        }
        Write-Host '[test-env] 当前主机没有 powershell.exe，使用已安装的 Apache Maven 3.9.16。'
        return @{ File = $maven.Source; Arguments = @('-Ppg-it', '-Dspring-boot.repackage.skip=true', 'verify') }
    }

    throw '未找到可用的 Maven Wrapper 或 Apache Maven 3.9.16。'
}

if ($Action -eq 'Help') {
    Show-Help
    exit 0
}

if (-not (Get-Command rtk -ErrorAction SilentlyContinue)) {
    throw '未找到 rtk。Git、Docker 命令必须通过 rtk 执行。'
}

Invoke-Checked -File 'rtk' -Arguments @('docker', 'info') -Description '检查 Docker 可用性'

if ($Action -in @('All', 'Backend')) {
    Push-Location $serverRoot
    try {
        $maven = Get-MavenCommand
        Invoke-Checked -File $maven.File -Arguments $maven.Arguments -Description '运行真实 PostgreSQL/MinIO Testcontainers 后端测试'
    }
    finally {
        Pop-Location
    }
}

if ($Action -in @('All', 'Frontend')) {
    Invoke-Checked -File 'npm.cmd' -Arguments @('--prefix', $webRoot, 'test') -Description '运行前端隔离回归测试'
    Invoke-Checked -File 'npm.cmd' -Arguments @('--prefix', $webRoot, 'run', 'build') -Description '构建真实 API 前端包'
}

Write-Host '[test-env] 测试环境已完成并由 Testcontainers 自动回收；结果不能替代页面验收。'
