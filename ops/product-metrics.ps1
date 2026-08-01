[CmdletBinding()]
param(
    [switch]$Local
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SqlPath = Join-Path $PSScriptRoot "product-metrics.sql"
$Wrangler = Join-Path $RepoRoot "node_modules\.bin\wrangler.cmd"
$Target = if ($Local) { "--local" } else { "--remote" }
$Sql = (Get-Content $SqlPath) -join " "

$Output = & $Wrangler d1 execute atsumari-guchi $Target --json --command $Sql
if ($LASTEXITCODE -ne 0) {
    throw "D1 metrics query failed with exit code $LASTEXITCODE"
}

$Payload = ($Output -join [Environment]::NewLine) | ConvertFrom-Json
$Row = $Payload[0].results[0]
if (-not $Row) {
    throw "D1 metrics query returned no result"
}

function Get-Percent {
    param([int]$Numerator, [int]$Denominator)
    if ($Denominator -eq 0) { return $null }
    return [Math]::Round(($Numerator / $Denominator) * 100, 1)
}

$Users = [int]$Row.users
$Creators = [int]$Row.creators
$Respondents = [int]$Row.respondents

[ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    service = "atsumari-guchi"
    environment = if ($Local) { "local" } else { "production" }
    funnel = [ordered]@{
        users = $Users
        creators = $Creators
        respondents = $Respondents
        gatherings_with_responses = [int]$Row.gatherings_with_responses
        response_updaters = [int]$Row.updaters
        waitlisted = [int]$Row.waitlisted
        promoted = [int]$Row.promoted
        roster_exporters = [int]$Row.exporters
        roster_exports = [int]$Row.exports
        calendar_users = [int]$Row.calendar_users
        public_viewers = [int]$Row.public_viewers
        returned = [int]$Row.returned
        created_7d = [int]$Row.created_7d
        respondents_7d = [int]$Row.respondents_7d
        qa_rows = [int]$Row.qa_rows
    }
    live_state = [ordered]@{
        open = [int]$Row.open_gatherings
        closed = [int]$Row.closed_gatherings
        cancelled = [int]$Row.cancelled_gatherings
        responses = [int]$Row.responses
        attending_seats = [int]$Row.attending_seats
        waitlisted_seats = [int]$Row.waitlisted_seats
    }
    rates = [ordered]@{
        creator_percent = Get-Percent $Creators $Users
        respondent_percent = Get-Percent $Respondents $Users
        exporter_percent = Get-Percent ([int]$Row.exporters) $Creators
        return_percent = Get-Percent ([int]$Row.returned) $Users
    }
} | ConvertTo-Json -Depth 4
