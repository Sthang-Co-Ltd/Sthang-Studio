param(
  [Parameter(Mandatory=$true)]
  [string]$SecretsStoreId,
  [string]$BucketName = 'sthang-studio-updates'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$Infra = Join-Path $Root 'infra\ota-signer'
$Template = Join-Path $Infra 'wrangler.template.jsonc'
$WorkerName = 'sthang-studio-ota-signer'
$WebhookUrl = 'https://signer.sthang.app/github/webhook'
$Repository = 'Sthang-Co-Ltd/Sthang-Studio'
$WebhookSecretName = 'STUDIO_GITHUB_WEBHOOK_SECRET'

function Invoke-Wrangler([string[]]$Arguments, [string]$InputText = '') {
  $Previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    if ($InputText) {
      $Output = $InputText | & npx.cmd wrangler @Arguments 2>&1
    } else {
      $Output = & npx.cmd wrangler @Arguments 2>&1
    }
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $Previous
  }
  [pscustomobject]@{
    ExitCode = $ExitCode
    Text = (($Output | ForEach-Object { "$_" }) -join "`r`n")
  }
}

function Invoke-Gh([string[]]$Arguments, [string]$InputText = '') {
  $Previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    if ($InputText) {
      $Output = $InputText | & gh.exe @Arguments 2>&1
    } else {
      $Output = & gh.exe @Arguments 2>&1
    }
    $ExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $Previous
  }
  [pscustomobject]@{
    ExitCode = $ExitCode
    Text = (($Output | ForEach-Object { "$_" }) -join "`r`n")
  }
}

if ($SecretsStoreId -notmatch '^[A-Za-z0-9_-]{8,128}$') { throw 'SecretsStoreId has an unexpected format.' }
if ($BucketName -notmatch '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$') { throw 'BucketName is not a valid R2 bucket name.' }
if (-not (Test-Path -LiteralPath $Template -PathType Leaf)) { throw 'Signer Wrangler template is missing.' }
foreach ($Command in @('node.exe','npx.cmd','gh.exe')) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command is required." }
}

Write-Host 'Checking Cloudflare authentication...' -ForegroundColor Cyan
$Whoami = Invoke-Wrangler @('whoami')
Write-Host $Whoami.Text
if ($Whoami.ExitCode -ne 0) { throw 'Wrangler authentication is required.' }

Write-Host 'Checking GitHub authentication and repository webhook access...' -ForegroundColor Cyan
$GhStatus = Invoke-Gh @('auth','status')
Write-Host $GhStatus.Text
if ($GhStatus.ExitCode -ne 0) { throw 'GitHub CLI authentication is required.' }
$ExistingHooks = Invoke-Gh @('api',"repos/$Repository/hooks",'--paginate')
if ($ExistingHooks.ExitCode -ne 0) { throw 'GitHub CLI needs repository Webhooks read/write permission.' }
if ($ExistingHooks.Text -match [regex]::Escape($WebhookUrl)) {
  throw "A webhook already targets $WebhookUrl. Refusing to create or rotate it implicitly."
}

Write-Host "Ensuring private R2 bucket $BucketName exists..." -ForegroundColor Cyan
$BucketList = Invoke-Wrangler @('r2','bucket','list')
Write-Host $BucketList.Text
if ($BucketList.ExitCode -ne 0) { throw 'Could not list R2 buckets.' }
if ($BucketList.Text -notmatch "(?m)\b$([regex]::Escape($BucketName))\b") {
  $CreateBucket = Invoke-Wrangler @('r2','bucket','create',$BucketName)
  Write-Host $CreateBucket.Text
  if ($CreateBucket.ExitCode -ne 0) { throw 'Could not create the Studio OTA R2 bucket.' }
}

$TempConfig = Join-Path $Infra ('.wrangler.production-' + [Guid]::NewGuid().ToString('N') + '.jsonc')
$TempBundle = Join-Path ([IO.Path]::GetTempPath()) ('sthang-studio-ota-signer-bundle-' + [Guid]::NewGuid().ToString('N'))
$WebhookSecret = $null
try {
  $ConfigText = [IO.File]::ReadAllText($Template)
  $ConfigText = $ConfigText.Replace('__STHANG_STUDIO_SECRETS_STORE_ID__', $SecretsStoreId)
  $ConfigText = $ConfigText.Replace('"bucket_name": "sthang-studio-updates"', '"bucket_name": "' + $BucketName + '"')
  [IO.File]::WriteAllText($TempConfig, $ConfigText, (New-Object Text.UTF8Encoding($false)))

  Write-Host 'Dry-running the production Worker bundle...' -ForegroundColor Cyan
  $DryRun = Invoke-Wrangler @('deploy','--config',$TempConfig,'--dry-run','--outdir',$TempBundle)
  Write-Host $DryRun.Text
  if ($DryRun.ExitCode -ne 0) { throw 'Worker dry-run failed.' }

  Write-Host 'Deploying the production signer Worker and custom domain...' -ForegroundColor Cyan
  $Deploy = Invoke-Wrangler @('deploy','--config',$TempConfig)
  Write-Host $Deploy.Text
  if ($Deploy.ExitCode -ne 0) { throw 'Worker deployment failed.' }

  $WebhookSecret = (& node.exe -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))").Trim()
  if ($LASTEXITCODE -ne 0 -or $WebhookSecret.Length -lt 48) { throw 'Could not generate a GitHub webhook secret.' }

  Write-Host 'Adding the Worker webhook secret through Wrangler stdin...' -ForegroundColor Cyan
  $PutSecret = Invoke-Wrangler @('secret','put',$WebhookSecretName,'--config',$TempConfig) $WebhookSecret
  Write-Host $PutSecret.Text
  if ($PutSecret.ExitCode -ne 0) { throw 'Could not create the Worker webhook secret.' }

  Write-Host 'Verifying public health endpoint...' -ForegroundColor Cyan
  $Health = Invoke-RestMethod -Uri 'https://signer.sthang.app/health' -Method Get -TimeoutSec 30
  if (-not $Health.ok -or $Health.service -ne 'sthang-studio-ota-signer') { throw 'Signer health check returned unexpected data.' }

  Write-Host 'Creating the repository issue-comment webhook...' -ForegroundColor Cyan
  $HookBody = [ordered]@{
    name = 'web'
    active = $true
    events = @('issue_comment')
    config = [ordered]@{
      url = $WebhookUrl
      content_type = 'json'
      secret = $WebhookSecret
      insecure_ssl = '0'
    }
  } | ConvertTo-Json -Depth 6 -Compress
  $CreateHook = Invoke-Gh @('api','-X','POST',"repos/$Repository/hooks",'--input','-') $HookBody
  Write-Host $CreateHook.Text
  if ($CreateHook.ExitCode -ne 0) { throw 'GitHub webhook creation failed. The Worker remains deployed but signing invocation is not connected.' }

  Write-Host ''
  Write-Host 'Production Studio signer deployment completed.' -ForegroundColor Green
  Write-Host "Worker:        $WorkerName"
  Write-Host 'Domain:        https://signer.sthang.app'
  Write-Host "R2 bucket:     $BucketName"
  Write-Host 'Webhook event: issue_comment'
  Write-Host 'Private key:   Cloudflare Secrets Store binding only'
  Write-Host ''
  Write-Host 'No GitHub Actions or Blacksmith runner was used.' -ForegroundColor Green
  Write-Host 'This deploys signing infrastructure only. It does not publish a Studio release or promote latest.json.' -ForegroundColor Yellow
}
finally {
  $WebhookSecret = $null
  if (Test-Path $TempConfig) { Remove-Item $TempConfig -Force -ErrorAction SilentlyContinue }
  if (Test-Path $TempBundle) { Remove-Item $TempBundle -Recurse -Force -ErrorAction SilentlyContinue }
}
