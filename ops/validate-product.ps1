[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerPath = Join-Path $RepoRoot "src\worker.tsx"
$AttendancePath = Join-Path $RepoRoot "src\domain\attendance.ts"
$MigrationPath = Join-Path $RepoRoot "migrations\0001_events.sql"
$AppPath = Join-Path $RepoRoot "public\app.js"
$EventPath = Join-Path $RepoRoot "public\event.js"
$StylesPath = Join-Path $RepoRoot "public\styles.css"
$WranglerPath = Join-Path $RepoRoot "wrangler.jsonc"
$PublicDirectory = Join-Path $RepoRoot "public"

$RequiredFiles = @(
    "DECISIONS.md",
    "EXPERIMENT.md",
    "METRICS.md",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "STACK.md",
    ".github\workflows\ci.yml",
    "migrations\0001_events.sql",
    "public\app.js",
    "public\event.js",
    "public\favicon.svg",
    "public\manifest.webmanifest",
    "public\styles.css",
    "public\og.svg",
    "public\robots.txt",
    "src\domain\attendance.ts",
    "src\worker.tsx"
)
foreach ($RelativePath in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $RelativePath))) {
        throw "Missing required release file: $RelativePath"
    }
}

$Worker = Get-Content -Raw -LiteralPath $WorkerPath
$Attendance = Get-Content -Raw -LiteralPath $AttendancePath
$Migration = Get-Content -Raw -LiteralPath $MigrationPath
$App = Get-Content -Raw -LiteralPath $AppPath
$Event = Get-Content -Raw -LiteralPath $EventPath
$Styles = Get-Content -Raw -LiteralPath $StylesPath
$Wrangler = Get-Content -Raw -LiteralPath $WranglerPath
$ProductSurface = @($Worker, $App, $Event) -join "`n"

if (-not $Worker.Contains('class="entrance-preview"') -or
    -not $Worker.Contains('class="venue-board"') -or
    -not $Worker.Contains('class="gate-post') -or
    -not $Worker.Contains('class="ticket-line"') -or
    -not $Worker.Contains('class="roster-board"')) {
    throw "Expected the entrance, capacity sign, tickets, and roster visualization"
}
if ($ProductSurface -match '(?i)public validation|success criteria|experiment|仮説|成功条件|市場スコア|移行候補|収益性') {
    throw "Research copy must not appear on the product surface"
}
if ($Styles -match '(?s)h1\s*\{[^}]*font-size:\s*(?:[4-9]\d|[1-9]\d{2})px') {
    throw "Primary heading is too large"
}
if ($Styles -match '(?i)gradient') {
    throw "Product CSS must not use gradients"
}
if ($Event -match '(?i)innerHTML|eval\(|new Function') {
    throw "User content must not be interpreted as markup or code"
}
if (-not $Event.Contains("window.location.hash") -and -not $Event.Contains("location.hash")) {
    throw "Capability keys must be read from URL fragments"
}
if (-not $Worker.Contains("organizer_token_hash") -or
    -not $Worker.Contains("token_hash") -or
    -not $Worker.Contains("await sha256(token)")) {
    throw "Capability URLs must store only key hashes"
}
if (-not $Worker.Contains("constantTimeEqual") -or
    -not $Worker.Contains("enforceSameOrigin") -or
    -not $Worker.Contains("create_rate_limited") -or
    -not $Worker.Contains("contact_not_allowed_in_")) {
    throw "Expected capability, origin, rate, and contact-data boundaries"
}
if (-not $Worker.Contains("endsAt + 14 * 86400") -or
    -not $Worker.Contains("45 * 86400") -or
    -not $Worker.Contains("DELETE FROM gatherings WHERE expires_at <= ?") -or
    -not $Migration.Contains("ON DELETE CASCADE")) {
    throw "Expected bounded gathering, response, and event retention"
}
if ($Migration -match '(?i)email|phone|real_name|photo|gender|birthday|payment|account_id|message_thread') {
    throw "Identity, contact, profile, payment, account, and chat data do not belong in this release"
}
if (-not $Migration.Contains("UNIQUE(gathering_id, session_id)") -or
    -not $Migration.Contains("UNIQUE(gathering_id, display_name_key)") -or
    -not $Migration.Contains("CREATE TABLE content_reports")) {
    throw "Expected duplicate-response and duplicate-report constraints"
}
if (-not $Attendance.Contains("countAttendingSeats") -or
    -not $Attendance.Contains("resolveRequestedChoice") -or
    -not $Attendance.Contains("chooseWaitlistPromotions") -or
    -not $Attendance.Contains("break")) {
    throw "Expected capacity and first-in waitlist behavior"
}
if (-not $Worker.Contains("csvSafe") -or
    -not $Worker.Contains("BEGIN:VCALENDAR") -or
    -not $Worker.Contains("roster.csv") -or
    -not $Worker.Contains("roster.json")) {
    throw "Expected safe roster exports and calendar output"
}
if ($Worker -match '(?i)better-auth|betterAuth') {
    throw "Account authentication is not needed for the capability-based release"
}
if ($Wrangler.Contains("TO_BE_CREATED")) {
    throw "The production D1 database ID has not been configured"
}

$OgPath = Join-Path $PublicDirectory "og.svg"
if ((Get-Item -LiteralPath $OgPath).Length -lt 2500) {
    throw "Expected a product-specific OG SVG larger than 2.5 KB"
}

$KeyFiles = @(
    Get-ChildItem -LiteralPath $PublicDirectory -File |
        Where-Object { $_.Name -match "^[a-zA-Z0-9-]{8,128}\.txt$" }
)
if ($KeyFiles.Count -ne 1) {
    throw "Expected exactly one generated IndexNow key file, found $($KeyFiles.Count)"
}
$Key = (Get-Content -Raw -LiteralPath $KeyFiles[0].FullName).Trim()
if ($Key -ne $KeyFiles[0].BaseName) {
    throw "IndexNow key file name and content do not match"
}

Write-Output "Product release contract is satisfied"
