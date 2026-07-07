# serve.ps1 — tiny static file server for local preview of barestkd.fit
# Serves the script's own folder at the SITE ROOT (so root-absolute paths like
# /assets/css/styles.css resolve correctly). No dependencies — pure .NET HttpListener.
#
# Usage:   powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8000]
# Then open the printed http://localhost:<port>/ address in your browser.
# Press Ctrl+C to stop.

param([int]$Port = 8000)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

$mime = @{
  '.html' = 'text/html; charset=utf-8';  '.htm'  = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';   '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.xml'  = 'application/xml; charset=utf-8'; '.txt'  = 'text/plain; charset=utf-8'
  '.svg'  = 'image/svg+xml';              '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg';                 '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif';                  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon';               '.mp4'  = 'video/mp4'
  '.webm' = 'video/webm';                 '.woff' = 'font/woff'
  '.woff2'= 'font/woff2';                 '.map'  = 'application/json'
}

function Resolve-RequestPath([string]$urlPath) {
  $p = [System.Uri]::UnescapeDataString($urlPath)
  if ([string]::IsNullOrEmpty($p) -or $p -eq '/') { return (Join-Path $root 'index.html') }
  $rel  = ($p.TrimStart('/')) -replace '/', '\'
  $full = Join-Path $root $rel
  if (Test-Path -LiteralPath $full -PathType Container) { return (Join-Path $full 'index.html') }
  if (Test-Path -LiteralPath $full -PathType Leaf)      { return $full }
  if (-not [System.IO.Path]::GetExtension($full)) {
    $idx = Join-Path $full 'index.html'
    if (Test-Path -LiteralPath $idx -PathType Leaf) { return $idx }
  }
  return $full   # may not exist -> caller sends 404
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host ""
Write-Host "  Bares TKD static server running" -ForegroundColor Green
Write-Host "  Root : $root"
Write-Host "  URL  : $prefix"
Write-Host "  Stop : Ctrl+C"
Write-Host ""

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $file = Resolve-RequestPath $req.Url.LocalPath

    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $ct  = $mime[$ext]; if (-not $ct) { $ct = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $res.StatusCode = 200
      $res.ContentType = $ct
    } else {
      $nf = Join-Path $root '404.html'
      if (Test-Path -LiteralPath $nf -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($nf)
      } else {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      }
      $res.StatusCode = 404
      $res.ContentType = 'text/html; charset=utf-8'
    }

    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.OutputStream.Close()
    Write-Host ("  {0}  {1}" -f $res.StatusCode, $req.Url.LocalPath)
  } catch {
    Write-Host "  ERR: $($_.Exception.Message)" -ForegroundColor Red
  }
}
