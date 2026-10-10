<#
.SYNOPSIS
  Pack this plugin into a .piplug the host will accept.

.DESCRIPTION
  PI-Desktop parses a .piplug itself, walking local file headers in order
  (crates/host-core/src/plugins/install.rs) and rejecting the whole package the
  moment an entry's compression method is not 0:

      if method != 0 {
          bail!("PLUGIN_INVALID: only store-compressed piplug supported");
      }

  So the archive must be built with compression *disabled*. `Compress-Archive`
  always deflates, which is why it produces a package the host refuses; the
  .NET ZipArchive below is created with CompressionLevel.NoCompression instead.

  Writing through ZipArchive also keeps the local header's compressed and
  uncompressed sizes in step and omits the optional data descriptor, whose
  signature (0x08074b50) would otherwise be read as the next entry's header.

  Entries come straight from the working tree rather than from a staged copy of
  it: the include list is already the exact set of files, so copying the tree
  first only added a temp directory to clean up.

  Run from the plugin root:  pwsh -File tools\pack.ps1

  This must be pwsh, not Windows PowerShell. The 5.1 host runs on .NET
  Framework, whose ZipArchive ignores CompressionLevel.NoCompression and
  deflates every entry anyway - so the archive below is built correctly and
  then rejected by the verifier for method 8. Only the .NET runtime in pwsh
  honours the level.
#>
[CmdletBinding()]
param(
  [string]$Output
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# Read through the framework, not Get-Content: the console code page on this
# machine cannot represent the manifest's Chinese, and a mojibaked document
# fails ConvertFrom-Json rather than parsing into a wrong value.
#
# Both the id and the version come from the manifest, so the package name cannot
# drift from the plugin it holds when either one is bumped.
$manifestPath = Join-Path $root 'manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not $manifest.id) { throw "manifest.json has no id ($manifestPath)" }
if (-not $manifest.version) { throw "manifest.json has no version ($manifestPath)" }
if (-not $Output) {
  $Output = Join-Path $root ('dist/{0}-{1}.piplug' -f $manifest.id, $manifest.version)
}

# Everything the plugin needs at run time, plus the sources it was built from.
# CHANGELOG.md and LICENSE are in the list because the host reads them for the
# Plugins page, so a dev pack that dropped them would ship a different plugin.
#
# docs/ is excluded on purpose. It is repository documentation - the README
# screenshots and the browser preview page - which nothing at run time reads, so
# shipping it would only add ~1MB of images to every install. The host's own
# packer has no way to express that exclusion (it walks everything but .git,
# node_modules and dist), so the two drivers can differ by exactly this one
# directory; this script is the one that produces the published artifact.
$include = @('manifest.json', 'main.js', 'package.json', 'package-lock.json', 'build.mjs', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'LICENSE', '.gitattributes', '.gitignore', 'tools', 'lib', 'renderer', 'src')

$rootFull = (Resolve-Path $root).Path
$entries = [System.Collections.Generic.List[object]]::new()
foreach ($item in $include) {
  $from = Join-Path $root $item
  if (-not (Test-Path $from)) { throw "missing required item: $item" }
  $full = (Resolve-Path $from).Path
  if (Test-Path $full -PathType Leaf) {
    $entries.Add([pscustomobject]@{ Name = $item; Path = $full })
  } else {
    foreach ($file in (Get-ChildItem $full -Recurse -File)) {
      $name = $file.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
      $entries.Add([pscustomobject]@{ Name = $name; Path = $file.FullName })
    }
  }
}

New-Item -ItemType Directory -Force -Path (Split-Path $Output) | Out-Null
Remove-Item $Output -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$stream = [System.IO.File]::Open($Output, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
try {
  # Sorted by entry name so two packs of the same tree list the files the same
  # way, which is what makes the package diffable by eye.
  foreach ($entry in ($entries | Sort-Object Name)) {
    $item = $zip.CreateEntry($entry.Name, [System.IO.Compression.CompressionLevel]::NoCompression)
    $item.LastWriteTime = [System.IO.File]::GetLastWriteTime($entry.Path)
    $entryStream = $item.Open()
    try {
      $bytes = [System.IO.File]::ReadAllBytes($entry.Path)
      $entryStream.Write($bytes, 0, $bytes.Length)
    } finally { $entryStream.Dispose() }
  }
} finally {
  $zip.Dispose()
  $stream.Dispose()
}

# Re-read the archive the way the host does, so a bad package fails here.
$bytes = [System.IO.File]::ReadAllBytes($Output)
$offset = 0; $count = 0
while ($offset + 30 -le $bytes.Length) {
  $sig = [System.BitConverter]::ToUInt32($bytes, $offset)
  if ($sig -eq 0x02014b50 -or $sig -eq 0x06054b50) { break }
  if ($sig -ne 0x04034b50) { throw ('bad zip local header at offset {0}' -f $offset) }
  $method = [System.BitConverter]::ToUInt16($bytes, $offset + 8)
  if ($method -ne 0) { throw ('only store-compressed piplug supported (method {0})' -f $method) }
  $compSize = [System.BitConverter]::ToUInt32($bytes, $offset + 18)
  $nameLen = [System.BitConverter]::ToUInt16($bytes, $offset + 26)
  $extraLen = [System.BitConverter]::ToUInt16($bytes, $offset + 28)
  $count++
  $offset = $offset + 30 + $nameLen + $extraLen + $compSize
}
if ($count -ne $entries.Count) {
  throw ('archive holds {0} entries but {1} were written' -f $count, $entries.Count)
}

$hash = (Get-FileHash $Output -Algorithm SHA256).Hash.ToLower()
$size = [math]::Round((Get-Item $Output).Length / 1KB, 1)
Write-Host ("packed {0} ({1} files, {2} KB, store-only)" -f $Output, $count, $size)
Write-Host ("sha256 {0}" -f $hash)
