# Builds the PZ2Harness proof-of-concept content pack.
#   -CobraTools  path to a cobra-tools checkout (https://github.com/OpenNaja/cobra-tools)
#   -Python      python with cobra-tools deps (numpy<2, imageio, pillow, bitarray~=2.9.2)
#   -Install     copy the built pack into the game's Win64\ovldata folder
param(
    [Parameter(Mandatory = $true)][string]$CobraTools,
    [string]$Python = "python",
    [string]$GameDir = "D:\SteamLibrary\steamapps\common\Planet Zoo 2",
    [switch]$Install
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$out = Join-Path $root "build\PZ2Harness"
New-Item -ItemType Directory -Force $out | Out-Null

# Native probe DLL (MSVC x64)
$vcvars = Get-ChildItem "$([Environment]::GetFolderPath('ProgramFiles'))\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat" |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $vcvars) { throw "MSVC (vcvars64.bat) not found" }
$src = Join-Path $root "native\pz2h_native.c"
$dll = Join-Path $out "pz2h_native.dll"
cmd /c "`"$vcvars`" >nul && cl /nologo /O2 /LD /MT `"$src`" /Fe:`"$dll`" /Fo:`"$out\\`" /link /NOLOGO"
if ($LASTEXITCODE -ne 0) { throw "cl failed" }
Remove-Item "$out\*.obj", "$out\*.exp", "$out\*.lib" -ErrorAction SilentlyContinue

# Main.ovl from the Lua sources (PZ2 uses the Planet Coaster 2 OVL format: version 20)
& $Python (Join-Path $CobraTools "ovl_tool_cmd.py") new -g "Planet Coaster 2" -i (Join-Path $root "PZ2Harness\Main") -o (Join-Path $out "Main.ovl") -f
if ($LASTEXITCODE -ne 0) { throw "ovl_tool_cmd failed" }
# Retail PZ2 OVLs have version_flag (header byte 4) = 0x01; cobra-tools' PC2 profile writes 0x00.
$ovl = Join-Path $out "Main.ovl"
$bytes = [IO.File]::ReadAllBytes($ovl)
$bytes[4] = 0x01
[IO.File]::WriteAllBytes($ovl, $bytes)
Copy-Item (Join-Path $root "PZ2Harness\Manifest.xml") $out -Force

if ($Install) {
    $dst = Join-Path $GameDir "Win64\ovldata\PZ2Harness"
    New-Item -ItemType Directory -Force $dst | Out-Null
    Copy-Item "$out\*" $dst -Force
    Write-Host "Installed to $dst (delete that folder to uninstall)"
}
