param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "ubuntu",

  [string]$RemoteDir = "/home/ubuntu/incircle-server",

  [int]$Port = 22,

  [string]$IdentityFile = "",

  [string]$WechatAppId = "",

  [string]$WechatAppSecret = "",

  [string]$PublicBaseUrl = "",

  [string]$LegalOperatorType = "individual",

  [string]$LegalOperatorName = "",

  [string]$LegalContactEmail = "",

  [string]$LegalTermsVersion = "",

  [string]$LegalPrivacyVersion = "",

  [string]$LegalEffectiveDate = "",

  [string]$SuperAdminOpenids = "",

  [switch]$UseSudo,

  [switch]$SkipBackup,

  [switch]$UseScp,

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [Parameter(Mandatory = $true)]
    [string]$ErrorMessage
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $ErrorMessage
  }
}

function ConvertTo-WindowsProcessArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Argument)

  if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') {
    return $Argument
  }

  $result = [System.Text.StringBuilder]::new()
  [void]$result.Append('"')
  $backslashCount = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq '\') {
      $backslashCount += 1
    } elseif ($character -eq '"') {
      [void]$result.Append("\" * (($backslashCount * 2) + 1))
      [void]$result.Append('"')
      $backslashCount = 0
    } else {
      if ($backslashCount -gt 0) {
        [void]$result.Append("\" * $backslashCount)
        $backslashCount = 0
      }
      [void]$result.Append($character)
    }
  }
  if ($backslashCount -gt 0) {
    [void]$result.Append("\" * ($backslashCount * 2))
  }
  [void]$result.Append('"')
  return $result.ToString()
}

function Join-WindowsProcessArguments {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  return (($Arguments | ForEach-Object { ConvertTo-WindowsProcessArgument $_ }) -join " ")
}

function Invoke-CheckedCommandWithInput {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [Parameter(Mandatory = $true)]
    [string]$InputText,

    [Parameter(Mandatory = $true)]
    [string]$ErrorMessage
  )

  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $FilePath
  $processInfo.Arguments = Join-WindowsProcessArguments $Arguments
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true

  $process = [System.Diagnostics.Process]::Start($processInfo)
  $exitCode = 1
  try {
    $inputBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($InputText)
    $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $process.StandardInput.Close()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
  } finally {
    $process.Dispose()
  }

  if ($exitCode -ne 0) {
    throw $ErrorMessage
  }
}

function Quote-RemoteValue {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "'`"`"'") + "'"
}

function ConvertTo-Base64Lines {
  param([Parameter(Mandatory = $true)][string]$Path)

  $base64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Path))
  $builder = [System.Text.StringBuilder]::new()
  for ($index = 0; $index -lt $base64.Length; $index += 76) {
    $length = [System.Math]::Min(76, $base64.Length - $index)
    [void]$builder.AppendLine($base64.Substring($index, $length))
  }
  return $builder.ToString()
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serverDir = Join-Path $root "server"
$packagePath = Join-Path $root "incircle-server.tar.gz"
$remotePackage = "$RemoteDir/incircle-server-release.tar.gz"
$remoteScript = "$RemoteDir/.deploy-incircle-server.sh"
$sshTarget = "${User}@${HostName}"

if (-not (Test-Path $serverDir)) {
  throw "Server directory not found: $serverDir"
}

$baseSshOptions = @()
$baseScpOptions = @()
if ($Port -ne 22) {
  $baseSshOptions += @("-p", [string]$Port)
  $baseScpOptions += @("-P", [string]$Port)
}
if ($IdentityFile) {
  $identityPath = (Resolve-Path $IdentityFile).Path
  $baseSshOptions += @("-i", $identityPath)
  $baseScpOptions += @("-i", $identityPath)
}

$sshOptions = $baseSshOptions
$scpOptions = $baseScpOptions

$remoteDeployScriptContent = @'
#!/usr/bin/env bash
set -euo pipefail

PACKAGE_PATH="${1:-incircle-server-release.tar.gz}"
WECHAT_APP_ID_VALUE="${WECHAT_APP_ID_VALUE:-your-wechat-app-id}"
WECHAT_APP_SECRET_VALUE="${WECHAT_APP_SECRET_VALUE:-}"
PUBLIC_BASE_URL_VALUE="${PUBLIC_BASE_URL_VALUE:-https://your-api.example.com}"
LEGAL_OPERATOR_TYPE_VALUE="${LEGAL_OPERATOR_TYPE_VALUE:-individual}"
LEGAL_OPERATOR_NAME_VALUE="${LEGAL_OPERATOR_NAME_VALUE:-}"
LEGAL_CONTACT_EMAIL_VALUE="${LEGAL_CONTACT_EMAIL_VALUE:-}"
LEGAL_TERMS_VERSION_VALUE="${LEGAL_TERMS_VERSION_VALUE:-}"
LEGAL_PRIVACY_VERSION_VALUE="${LEGAL_PRIVACY_VERSION_VALUE:-}"
LEGAL_EFFECTIVE_DATE_VALUE="${LEGAL_EFFECTIVE_DATE_VALUE:-}"
SUPER_ADMIN_OPENIDS_VALUE="${SUPER_ADMIN_OPENIDS_VALUE:-}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
USE_SUDO="${USE_SUDO:-0}"

docker_cmd() {
  if [ "$USE_SUDO" = "1" ]; then
    sudo docker "$@"
  else
    docker "$@"
  fi
}

compose() {
  if docker_cmd compose version >/dev/null 2>&1; then
    docker_cmd compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    if [ "$USE_SUDO" = "1" ]; then
      sudo docker-compose "$@"
    else
      docker-compose "$@"
    fi
  else
    echo "docker compose or docker-compose is required" >&2
    exit 1
  fi
}

check_docker_access() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed or not in PATH." >&2
    exit 1
  fi
  if ! docker_cmd info >/dev/null 2>&1; then
    cat >&2 <<'EOF'
Current user cannot access Docker.

Recommended one-time fix on the server:
  sudo usermod -aG docker ubuntu
  exit

Then SSH in again and rerun this deploy script.

If your server already has passwordless sudo for docker, rerun with:
  -UseSudo
EOF
    exit 1
  fi
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "${1:-32}" | tr -d '/+=' | cut -c1-"${2:-32}"
  else
    date +%s%N | sha256sum | cut -c1-"${2:-32}"
  fi
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "${1:-32}"
  else
    date +%s%N | sha256sum | cut -c1-$(( ${1:-32} * 2 ))
  fi
}

env_value() {
  local key="$1"
  local fallback="${2:-}"
  if [ -f .env ]; then
    local value
    value="$(grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- || true)"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return
    fi
  fi
  printf '%s' "$fallback"
}

ensure_line() {
  local key="$1"
  local value="$2"
  if [ ! -f .env ] || ! grep -qE "^${key}=" .env; then
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

fill_empty_line() {
  local key="$1"
  local value="$2"
  if [ -f .env ] && grep -qE "^${key}=$" .env; then
    sed -i "s#^${key}=.*#${key}=${value}#" .env
  fi
}

set_line() {
  local key="$1"
  local value="$2"
  case "$value" in
    *$'\r'*|*$'\n'*)
      echo "Invalid line break in ${key}." >&2
      exit 1
      ;;
  esac
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[\\&#]/\\&/g')"
  if [ -f .env ] && grep -qE "^${key}=" .env; then
    sed -i "s#^${key}=.*#${key}=${escaped}#" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

password_from_database_url() {
  if [ ! -f .env ]; then
    return 0
  fi
  sed -n 's#^DATABASE_URL=postgres://incircle:\([^@]*\)@postgres:5432/incircle#\1#p' .env | head -n 1
}

ensure_env() {
  if [ ! -f .env ]; then
    local db_password
    if compose ps -q postgres >/dev/null 2>&1 && [ -n "$(compose ps -q postgres 2>/dev/null || true)" ]; then
      db_password="change-this-password"
      echo "Created .env with the legacy database password because an existing postgres container was detected."
    else
      db_password="$(random_token 24 24)"
      echo "Created .env with a generated database password."
    fi
    local jwt_secret
    jwt_secret="$(random_token 48 64)"
    cat > .env <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
POSTGRES_PASSWORD=${db_password}
DATABASE_URL=postgres://incircle:${db_password}@postgres:5432/incircle
CORS_ORIGINS=${PUBLIC_BASE_URL_VALUE}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL_VALUE}
UPLOAD_DIR=/app/uploads
LEGAL_OPERATOR_TYPE=${LEGAL_OPERATOR_TYPE_VALUE}
LEGAL_OPERATOR_NAME=${LEGAL_OPERATOR_NAME_VALUE}
LEGAL_CONTACT_EMAIL=${LEGAL_CONTACT_EMAIL_VALUE}
LEGAL_TERMS_VERSION=${LEGAL_TERMS_VERSION_VALUE}
LEGAL_PRIVACY_VERSION=${LEGAL_PRIVACY_VERSION_VALUE}
LEGAL_EFFECTIVE_DATE=${LEGAL_EFFECTIVE_DATE_VALUE}
WECHAT_APP_ID=${WECHAT_APP_ID_VALUE}
WECHAT_APP_SECRET=${WECHAT_APP_SECRET_VALUE}
WECHAT_QRCODE_ENV_VERSION=release
INCIRCLE_SUPER_ADMIN_OPENIDS=${SUPER_ADMIN_OPENIDS_VALUE}
JWT_SECRET=${jwt_secret}
JWT_TTL_SECONDS=86400
AI_CREDENTIALS_ENCRYPTION_KEY=$(random_hex 32)
AI_PROVIDER_TIMEOUT_MS=300000
AI_CONTENT_SECURITY_ENABLED=true
EOF
    chmod 600 .env
    return
  fi

  local db_password
  db_password="$(env_value POSTGRES_PASSWORD)"
  if [ -z "$db_password" ]; then
    db_password="$(password_from_database_url)"
  fi
  if [ -z "$db_password" ]; then
    db_password="$(random_token 24 24)"
  fi

  ensure_line NODE_ENV production
  set_line HOST 0.0.0.0
  set_line PORT 3000
  ensure_line POSTGRES_PASSWORD "$db_password"
  ensure_line DATABASE_URL "postgres://incircle:${db_password}@postgres:5432/incircle"
  ensure_line CORS_ORIGINS "$PUBLIC_BASE_URL_VALUE"
  ensure_line PUBLIC_BASE_URL "$PUBLIC_BASE_URL_VALUE"
  ensure_line UPLOAD_DIR '/app/uploads'
  ensure_line LEGAL_OPERATOR_TYPE "$LEGAL_OPERATOR_TYPE_VALUE"
  ensure_line LEGAL_OPERATOR_NAME "$LEGAL_OPERATOR_NAME_VALUE"
  ensure_line LEGAL_CONTACT_EMAIL "$LEGAL_CONTACT_EMAIL_VALUE"
  ensure_line LEGAL_TERMS_VERSION "$LEGAL_TERMS_VERSION_VALUE"
  ensure_line LEGAL_PRIVACY_VERSION "$LEGAL_PRIVACY_VERSION_VALUE"
  ensure_line LEGAL_EFFECTIVE_DATE "$LEGAL_EFFECTIVE_DATE_VALUE"
  ensure_line WECHAT_APP_ID "$WECHAT_APP_ID_VALUE"
  ensure_line WECHAT_APP_SECRET "$WECHAT_APP_SECRET_VALUE"
  ensure_line WECHAT_QRCODE_ENV_VERSION 'release'
  ensure_line INCIRCLE_SUPER_ADMIN_OPENIDS "$SUPER_ADMIN_OPENIDS_VALUE"
  ensure_line JWT_SECRET "$(random_token 48 64)"
  ensure_line JWT_TTL_SECONDS '86400'
  ensure_line AI_CREDENTIALS_ENCRYPTION_KEY "$(random_hex 32)"
  ensure_line AI_PROVIDER_TIMEOUT_MS '300000'
  if grep -qE '^AI_PROVIDER_TIMEOUT_MS=(55000|120000)$' .env; then
    sed -i -E 's#^AI_PROVIDER_TIMEOUT_MS=(55000|120000)$#AI_PROVIDER_TIMEOUT_MS=300000#' .env
    echo "Upgraded legacy AI provider idle timeout to 300000ms."
  fi
  ensure_line AI_CONTENT_SECURITY_ENABLED 'true'
  fill_empty_line AI_CREDENTIALS_ENCRYPTION_KEY "$(random_hex 32)"
  fill_empty_line WECHAT_APP_ID "$WECHAT_APP_ID_VALUE"
  if [ -n "$WECHAT_APP_SECRET_VALUE" ]; then
    fill_empty_line WECHAT_APP_SECRET "$WECHAT_APP_SECRET_VALUE"
  fi
  fill_empty_line PUBLIC_BASE_URL "$PUBLIC_BASE_URL_VALUE"
  fill_empty_line LEGAL_OPERATOR_TYPE "$LEGAL_OPERATOR_TYPE_VALUE"
  if [ -n "$LEGAL_OPERATOR_NAME_VALUE" ]; then
    fill_empty_line LEGAL_OPERATOR_NAME "$LEGAL_OPERATOR_NAME_VALUE"
  fi
  if [ -n "$LEGAL_CONTACT_EMAIL_VALUE" ]; then
    fill_empty_line LEGAL_CONTACT_EMAIL "$LEGAL_CONTACT_EMAIL_VALUE"
  fi
  if [ -n "$LEGAL_TERMS_VERSION_VALUE" ]; then
    fill_empty_line LEGAL_TERMS_VERSION "$LEGAL_TERMS_VERSION_VALUE"
  fi
  if [ -n "$LEGAL_PRIVACY_VERSION_VALUE" ]; then
    fill_empty_line LEGAL_PRIVACY_VERSION "$LEGAL_PRIVACY_VERSION_VALUE"
  fi
  if [ -n "$LEGAL_EFFECTIVE_DATE_VALUE" ]; then
    fill_empty_line LEGAL_EFFECTIVE_DATE "$LEGAL_EFFECTIVE_DATE_VALUE"
  fi
  if [ -n "$SUPER_ADMIN_OPENIDS_VALUE" ]; then
    fill_empty_line INCIRCLE_SUPER_ADMIN_OPENIDS "$SUPER_ADMIN_OPENIDS_VALUE"
  fi
  chmod 600 .env
  echo "Preserved existing .env and filled missing keys."
}

backup_database() {
  if [ "$SKIP_BACKUP" = "1" ]; then
    echo "Skipping database backup by request."
    return
  fi
  if ! compose ps -q postgres >/dev/null 2>&1 || [ -z "$(compose ps -q postgres 2>/dev/null || true)" ]; then
    echo "No running postgres service found; skipping backup."
    return
  fi
  if ! compose exec -T postgres pg_isready -U incircle -d incircle >/dev/null 2>&1; then
    echo "Postgres is not ready; skipping backup."
    return
  fi

  mkdir -p "$HOME/incircle-backups"
  local backup_file="$HOME/incircle-backups/incircle-$(date +%F-%H%M%S).sql"
  compose exec -T postgres pg_dump -U incircle -d incircle > "$backup_file"
  echo "Database backup written to $backup_file"
}

echo "Preparing InCircle server deployment in $(pwd)"
ensure_env
check_docker_access
backup_database

echo "Extracting package $PACKAGE_PATH"
tar -xzf "$PACKAGE_PATH" -C .
ensure_env

echo "Building API image"
compose build api
compose up -d postgres

echo "Stopping API for database migration"
compose stop api >/dev/null 2>&1 || true
compose run --rm api npm run db:migrate

echo "Starting API container"
compose up -d api

PORT_VALUE="$(env_value PORT 3000)"
HEALTH_URL="http://127.0.0.1:${PORT_VALUE}/health"
echo "Checking $HEALTH_URL"
health_ok=0
for attempt in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "$HEALTH_URL"; then
      health_ok=1
      break
    fi
  elif wget -qO- "$HEALTH_URL"; then
    health_ok=1
    break
  fi
  echo "Health check not ready yet (${attempt}/30); waiting 2s..."
  sleep 2
done
if [ "$health_ok" != "1" ]; then
  echo "Health check failed after waiting. Container status:" >&2
  compose ps >&2 || true
  echo "Recent API logs:" >&2
  compose logs --tail=160 api >&2 || true
  exit 1
fi

PUBLISHED_API="$(compose port api 3000 2>/dev/null | head -n 1 || true)"
case "$PUBLISHED_API" in
  127.0.0.1:*) echo "API port is bound to loopback: $PUBLISHED_API" ;;
  *)
    echo "Unsafe API port binding detected: ${PUBLISHED_API:-not published}" >&2
    exit 1
    ;;
esac

LEGAL_PROFILE_URL="http://127.0.0.1:${PORT_VALUE}/api/incircle"
LEGAL_PROFILE_PAYLOAD='{"type":"incirclePublicLegalProfile","circleId":""}'
echo "Checking public legal profile"
legal_profile_ok=0
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -o /dev/null -X POST "$LEGAL_PROFILE_URL" \
    -H 'Content-Type: application/json' --data "$LEGAL_PROFILE_PAYLOAD"; then
    legal_profile_ok=1
  fi
elif wget -qO- --header='Content-Type: application/json' \
  --post-data="$LEGAL_PROFILE_PAYLOAD" "$LEGAL_PROFILE_URL" >/dev/null; then
  legal_profile_ok=1
fi
if [ "$legal_profile_ok" != "1" ]; then
  echo "Public legal profile check failed after migration." >&2
  compose logs --tail=80 api >&2 || true
  exit 1
fi
echo "Public legal profile endpoint is ready."
echo
echo "InCircle self-hosted backend deploy completed."
'@

$tempRemoteScript = Join-Path ([System.IO.Path]::GetTempPath()) ("incircle-deploy-remote-{0}.sh" -f ([System.Guid]::NewGuid().ToString("N")))

try {
  if (Test-Path $packagePath) {
    Remove-Item -LiteralPath $packagePath -Force
  }

  Write-Host "Packing server directory..."
  Invoke-CheckedCommand -FilePath "tar" -Arguments @(
    "--exclude=node_modules",
    "--exclude=.env",
    "--exclude=uploads",
    "--exclude=cloudbase-export",
    "-C",
    $serverDir,
    "-czf",
    $packagePath,
    "."
  ) -ErrorMessage "Failed to create deployment package"

  $package = Get-Item $packagePath
  Write-Host ("Package ready: {0} ({1} bytes)" -f $package.FullName, $package.Length)

  if ($DryRun) {
    Write-Host "Dry run only. No upload or remote deploy was executed."
    Write-Host "Remote target: ${sshTarget}:$RemoteDir"
    exit 0
  }

  [System.IO.File]::WriteAllText($tempRemoteScript, $remoteDeployScriptContent, [System.Text.UTF8Encoding]::new($false))

  $quotedRemoteDir = Quote-RemoteValue $RemoteDir
  $quotedRemoteScript = Quote-RemoteValue $remoteScript
  $quotedRemotePackage = Quote-RemoteValue $remotePackage
  $quotedWechatAppId = Quote-RemoteValue $WechatAppId
  $quotedWechatAppSecret = Quote-RemoteValue $WechatAppSecret
  $quotedPublicBaseUrl = Quote-RemoteValue $PublicBaseUrl
  $quotedLegalOperatorType = Quote-RemoteValue $LegalOperatorType
  $quotedLegalOperatorName = Quote-RemoteValue $LegalOperatorName
  $quotedLegalContactEmail = Quote-RemoteValue $LegalContactEmail
  $quotedLegalTermsVersion = Quote-RemoteValue $LegalTermsVersion
  $quotedLegalPrivacyVersion = Quote-RemoteValue $LegalPrivacyVersion
  $quotedLegalEffectiveDate = Quote-RemoteValue $LegalEffectiveDate
  $quotedSuperAdminOpenids = Quote-RemoteValue $SuperAdminOpenids
  $skipBackupValue = if ($SkipBackup) { "1" } else { "0" }
  $useSudoValue = if ($UseSudo) { "1" } else { "0" }

  if ($UseScp) {
    Write-Host "Ensuring remote directory exists..."
    Invoke-CheckedCommand -FilePath "ssh" -Arguments ($sshOptions + @(
      $sshTarget,
      "mkdir -p $quotedRemoteDir"
    )) -ErrorMessage "Failed to create remote directory"

    Write-Host "Uploading package and deploy helper..."
    Invoke-CheckedCommand -FilePath "scp" -Arguments ($scpOptions + @(
      $packagePath,
      "${sshTarget}:$remotePackage"
    )) -ErrorMessage "Failed to upload deployment package"

    Invoke-CheckedCommand -FilePath "scp" -Arguments ($scpOptions + @(
      $tempRemoteScript,
      "${sshTarget}:$remoteScript"
    )) -ErrorMessage "Failed to upload remote deploy script"

    Write-Host "Running remote deploy..."
    $remoteCommand = "cd $quotedRemoteDir && chmod +x $quotedRemoteScript && WECHAT_APP_ID_VALUE=$quotedWechatAppId WECHAT_APP_SECRET_VALUE=$quotedWechatAppSecret PUBLIC_BASE_URL_VALUE=$quotedPublicBaseUrl LEGAL_OPERATOR_TYPE_VALUE=$quotedLegalOperatorType LEGAL_OPERATOR_NAME_VALUE=$quotedLegalOperatorName LEGAL_CONTACT_EMAIL_VALUE=$quotedLegalContactEmail LEGAL_TERMS_VERSION_VALUE=$quotedLegalTermsVersion LEGAL_PRIVACY_VERSION_VALUE=$quotedLegalPrivacyVersion LEGAL_EFFECTIVE_DATE_VALUE=$quotedLegalEffectiveDate SUPER_ADMIN_OPENIDS_VALUE=$quotedSuperAdminOpenids SKIP_BACKUP=$skipBackupValue USE_SUDO=$useSudoValue bash $quotedRemoteScript $quotedRemotePackage"
    Invoke-CheckedCommand -FilePath "ssh" -Arguments ($sshOptions + @(
      $sshTarget,
      $remoteCommand
    )) -ErrorMessage "Remote deployment failed"
  } else {
    Write-Host "Uploading package and running remote deploy over one SSH connection..."
    Write-Host "You should only need to enter the SSH password once."

    $packageBase64 = ConvertTo-Base64Lines $packagePath
    $remoteScriptBase64 = ConvertTo-Base64Lines $tempRemoteScript
    $packageSha256 = Get-FileSha256 $packagePath
    $remoteScriptSha256 = Get-FileSha256 $tempRemoteScript
    $remoteBootstrapScriptContent = @"
#!/usr/bin/env bash
set -euo pipefail

REMOTE_DIR=$quotedRemoteDir
REMOTE_PACKAGE=$quotedRemotePackage
REMOTE_SCRIPT=$quotedRemoteScript
PACKAGE_SHA256='$packageSha256'
REMOTE_SCRIPT_SHA256='$remoteScriptSha256'

mkdir -p "`$REMOTE_DIR"

base64 -d > "`$REMOTE_PACKAGE" <<'INCIRCLE_PACKAGE_B64'
$packageBase64
INCIRCLE_PACKAGE_B64

base64 -d > "`$REMOTE_SCRIPT" <<'INCIRCLE_DEPLOY_SCRIPT_B64'
$remoteScriptBase64
INCIRCLE_DEPLOY_SCRIPT_B64

if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "`$PACKAGE_SHA256" "`$REMOTE_PACKAGE" | sha256sum -c -
  printf '%s  %s\n' "`$REMOTE_SCRIPT_SHA256" "`$REMOTE_SCRIPT" | sha256sum -c -
fi

cd "`$REMOTE_DIR"
chmod +x "`$REMOTE_SCRIPT"
WECHAT_APP_ID_VALUE=$quotedWechatAppId WECHAT_APP_SECRET_VALUE=$quotedWechatAppSecret PUBLIC_BASE_URL_VALUE=$quotedPublicBaseUrl LEGAL_OPERATOR_TYPE_VALUE=$quotedLegalOperatorType LEGAL_OPERATOR_NAME_VALUE=$quotedLegalOperatorName LEGAL_CONTACT_EMAIL_VALUE=$quotedLegalContactEmail LEGAL_TERMS_VERSION_VALUE=$quotedLegalTermsVersion LEGAL_PRIVACY_VERSION_VALUE=$quotedLegalPrivacyVersion LEGAL_EFFECTIVE_DATE_VALUE=$quotedLegalEffectiveDate SUPER_ADMIN_OPENIDS_VALUE=$quotedSuperAdminOpenids SKIP_BACKUP=$skipBackupValue USE_SUDO=$useSudoValue bash "`$REMOTE_SCRIPT" "`$REMOTE_PACKAGE"
"@.Replace("`r`n", "`n")

    Invoke-CheckedCommandWithInput -FilePath "ssh" -Arguments ($sshOptions + @(
      $sshTarget,
      "bash -s"
    )) -InputText $remoteBootstrapScriptContent -ErrorMessage "Remote deployment failed"
  }
} finally {
  if (Test-Path $tempRemoteScript) {
    Remove-Item -LiteralPath $tempRemoteScript -Force -ErrorAction SilentlyContinue
  }
}
