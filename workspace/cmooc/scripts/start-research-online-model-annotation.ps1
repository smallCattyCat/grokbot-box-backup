[CmdletBinding()]
param(
    [ValidateSet('Check', 'Probe', 'Run')]
    [string]$Action = 'Check',

    [ValidateSet('DeepSeek', 'DashScope', 'Aipaibox')]
    [string]$Provider = 'DashScope',

    [string]$InputRoot,

    [string]$OutputDir,

    [string]$SelectionFile,

    [string]$BatchDir = "$env:LOCALAPPDATA\cmooc-research\p1d\facilitation-review-300-v1",

    [string]$ResearchDatabase = "$env:LOCALAPPDATA\cmooc-research\p1c\research-cmooc-2024-2025-p1c.db",

    [string]$ProtectedKey = "$env:LOCALAPPDATA\cmooc-research\secrets\research-hmac-p1c.dpapi",

    [string]$ProviderSettings = "$env:USERPROFILE\.claude\settings.json",

    [string]$ExpectedHost,

    [string]$BaseUrl,

    [string]$Model,

    [ValidateRange(1, 1800)]
    [double]$TimeoutSeconds = 120,

    [ValidateRange(128, 4096)]
    [int]$MaxTokens = 1024,

    [switch]$Resume,

    [switch]$AuthorizeRedactedResearchTransfer
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptRoot 'research_online_model_annotation.py'
if (-not (Test-Path -LiteralPath $runner)) {
    throw "Required online model path is unavailable: $runner"
}

$apiKey = $null
if ($Provider -eq 'DeepSeek') {
    $providerHost = 'api.deepseek.com'
    $protocol = 'anthropic_messages_2023_06_01'
    foreach ($scope in @('Process', 'User', 'Machine')) {
        $candidate = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', $scope)
        if ($candidate) {
            $apiKey = [string]$candidate
            break
        }
    }
    if (-not $BaseUrl) {
        $BaseUrl = 'https://api.deepseek.com/anthropic'
    }
    if (-not $Model) {
        $Model = 'deepseek-v4-flash'
    }
} elseif ($Provider -eq 'DashScope') {
    $providerHost = 'dashscope.aliyuncs.com'
    $protocol = 'dashscope_encrypted_aes_gcm_v1'
    foreach ($scope in @('Process', 'User', 'Machine')) {
        $candidate = [Environment]::GetEnvironmentVariable('DASHSCOPE_API_KEY', $scope)
        if ($candidate) {
            $apiKey = [string]$candidate
            break
        }
    }
    if (-not $BaseUrl) {
        $BaseUrl = 'https://dashscope.aliyuncs.com/api/v1'
    }
    if (-not $Model) {
        $Model = 'qwen3.7-max'
    }
} else {
    $providerHost = 'api.aipaibox.com'
    $protocol = 'anthropic_messages_2023_06_01'
    if (-not (Test-Path -LiteralPath $ProviderSettings)) {
        throw "Required online model path is unavailable: $ProviderSettings"
    }
    $settings = Get-Content -LiteralPath $ProviderSettings -Raw -Encoding UTF8 | ConvertFrom-Json
    $providerEnv = $settings.env
    $apiKey = [string]$providerEnv.ANTHROPIC_AUTH_TOKEN
    if (-not $BaseUrl) {
        $BaseUrl = [string]$providerEnv.ANTHROPIC_BASE_URL
    }
    if (-not $Model) {
        $Model = [string]$providerEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL
    }
}
if ($ExpectedHost -and $ExpectedHost -ne $providerHost) {
    throw 'ExpectedHost cannot override the selected provider host.'
}
$ExpectedHost = $providerHost
if (-not $apiKey -or -not $BaseUrl -or -not $Model) {
    throw 'The online model provider configuration is incomplete.'
}
$providerUri = [Uri]$BaseUrl
if ($providerUri.Scheme -ne 'https' -or $providerUri.Host -ne $ExpectedHost) {
    throw 'The configured online model endpoint does not match ExpectedHost over HTTPS.'
}

if ($Action -in @('Check', 'Run')) {
    foreach ($requiredPath in @($InputRoot, $BatchDir, $ResearchDatabase, $ProtectedKey)) {
        if (-not $requiredPath -or -not (Test-Path -LiteralPath $requiredPath)) {
            throw "Required local research path is unavailable: $requiredPath"
        }
    }
    if ($SelectionFile -and -not (Test-Path -LiteralPath $SelectionFile)) {
        throw "Selection file is unavailable: $SelectionFile"
    }
}
if ($Action -eq 'Run' -and (-not $OutputDir -or -not $AuthorizeRedactedResearchTransfer)) {
    throw 'Run requires OutputDir and -AuthorizeRedactedResearchTransfer.'
}
if ($Action -ne 'Run' -and ($OutputDir -or $Resume -or $AuthorizeRedactedResearchTransfer)) {
    throw 'OutputDir, Resume, and authorization are only valid for Action=Run.'
}

$protectedBytes = $null
$plainKey = $null
try {
    $env:CMOOC_ONLINE_MODEL_API_KEY = $apiKey
    $arguments = @(
        $runner,
        $Action.ToLowerInvariant(),
        '--base-url', $BaseUrl,
        '--expected-host', $ExpectedHost,
        '--model', $Model,
        '--protocol', $protocol
    )
    if ($Action -in @('Check', 'Run')) {
        Add-Type -AssemblyName System.Security
        $protectedBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ProtectedKey))
        $plainKey = [Security.Cryptography.ProtectedData]::Unprotect(
            $protectedBytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        if ($plainKey.Length -lt 32) {
            throw 'The unprotected research key is invalid.'
        }
        $env:CMOOC_RESEARCH_HMAC_KEY_B64 = [Convert]::ToBase64String($plainKey)
        $arguments += @(
            '--batch-dir', (Resolve-Path -LiteralPath $BatchDir),
            '--research-database', (Resolve-Path -LiteralPath $ResearchDatabase),
            '--input-root', (Resolve-Path -LiteralPath $InputRoot)
        )
        if ($SelectionFile) {
            $arguments += @('--selection-file', (Resolve-Path -LiteralPath $SelectionFile))
        }
    }
    if ($Action -eq 'Run') {
        $arguments += @(
            '--output-dir', $OutputDir,
            '--consent-phrase', 'I_AUTHORIZE_REDACTED_RESEARCH_DATA_TRANSFER',
            '--timeout-seconds', $TimeoutSeconds,
            '--max-tokens', $MaxTokens
        )
        if ($Resume) {
            $arguments += '--resume'
        }
    }
    & python @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "The online research annotation runner exited with code $LASTEXITCODE."
    }
}
finally {
    Remove-Item Env:CMOOC_ONLINE_MODEL_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:CMOOC_RESEARCH_HMAC_KEY_B64 -ErrorAction SilentlyContinue
    $apiKey = $null
    if ($plainKey) {
        [Array]::Clear($plainKey, 0, $plainKey.Length)
    }
    if ($protectedBytes) {
        [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
    }
}
