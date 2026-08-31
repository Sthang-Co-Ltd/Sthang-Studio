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

if ($SecretsStoreId -notmatch '^[A-Za-z0-9_-]{8,128}$') {
  throw 'SecretsStoreId has an unexpected format.'
}
if ($BucketName -notmatch '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$') {
  throw 'BucketName is not a valid R2 bucket name.'
}
foreach ($Command in @('node.exe','npx.cmd','gh.exe')) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command is required." }
}

Write-Host 'Checking Cloudflare authentication...' -ForegroundColor Cyan
& npx.cmd wrangler whoami
if ($LASTEXITCODE -ne 0) { throw 'Wrangler authentication is required.' }

Write-Host 'Checking GitHub authentication and repository-admin API access...' -ForegroundColor Cyan
& gh.exe auth status
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI authentication is required.' }
$ExistingHooks = & gh.exe api "repos/$Repository/hooks" --paginate 2>$null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI needs repository Webhooks read/write permission.' }
if (($ExistingHooks | Out-String) -match [regex]::Escape($WebhookUrl)) {
  throw "A webhook already targets $WebhookUrl. Refusing to create or rotate it implicitly."
}

Write-Host "Ensuring private R2 bucket $BucketName exists..." -ForegroundColor Cyan
$BucketList = (& npx.cmd wrangler r2 bucket list 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not list R2 buckets.' }
if ($BucketList -notmatch "(?m)\b$([regex]::Escape($BucketName))\b") {
  & npx.cmd wrangler r2 bucket create $BucketName
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the Studio OTA R2 bucket.' }
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ('sthang-studio-ota-signer-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temp -Force | Out-Null
$TempConfig = Join-Path $Temp 'wrangler.jsonc'
$WebhookSecret = $null
try {
  $ConfigText = [IO.File]::ReadAllText($Template)
  $ConfigText = $ConfigText.Replace('__STHANG_STUDIO_SECRETS_STORE_ID__', $SecretsStoreId)
  $ConfigText = $ConfigText.Replace('"bucket_name": "sthang-studio-updates"', '"bucket_name": "' + $BucketName + '"')
  [IO.File]::WriteAllText($TempConfig, $ConfigText, (New-Object Text.UTF8Encoding($false)))

  $WebhookSecret = (& node.exe -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))").Trim()
  if ($LASTEXITCODE -ne 0 -or $WebhookSecret.Length -lt 48) { throw 'Could not generate a GitHub webhook secret.' }

  Write-Host 'Creating the Worker webhook secret without placing it on the command line...' -ForegroundColor Cyan
  $WebhookSecret | & npx.cmd wrangler secret put $WebhookSecretName --config $TempConfig
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the Worker webhook secret.' }

  Write-Host 'Dry-running the production Worker bundle...' -ForegroundColor Cyan
  & npx.cmd wrangler deploy --config $TempConfig --dry-run --outdir (Join-Path $Temp 'bundle')
  if ($LASTEXITCODE -ne 0) { throw 'Worker dry-run failed.' }

  Write-Host 'Deploying the production signer Worker and custom domain...' -ForegroundColor Cyan
  & npx.cmd wrangler deploy --config $TempConfig
  if ($LASTEXITCODE -ne 0) { throw 'Worker deployment failed.' }

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
  $HookBody | & gh.exe api -X POST "repos/$Repository/hooks" --input -
  if ($LASTEXITCODE -ne 0) { throw 'GitHub webhook creation failed. The Worker remains deployed but signing invocation is not connected.' }

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
  if (Test-Path $Temp) { Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue }
}
