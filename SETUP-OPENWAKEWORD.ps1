$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$venv = Join-Path $PSScriptRoot ".venv-openwakeword"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw "Brak Python Launcher 'py'. Zainstaluj Python 3.11 x64 i uruchom skrypt ponownie."
}

if (-not (Test-Path $python)) {
  Write-Host "Tworzę środowisko Python dla openWakeWord..."
  py -3.11 -m venv $venv
}

& $python -m pip install --upgrade pip
& $python -m pip install "openwakeword" "onnxruntime" "numpy"

Write-Host ""
Write-Host "openWakeWord zainstalowany."
Write-Host "Python sidecara: $python"
Write-Host ""
Write-Host "WAŻNE: REZE potrzebuje własnego modelu wake word."
Write-Host "Umieść plik:"
Write-Host "  wake-models\reze.onnx"
Write-Host ""
Write-Host "Po dodaniu modelu uruchom: npm run dev"
