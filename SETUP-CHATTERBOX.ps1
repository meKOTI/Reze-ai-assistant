$ErrorActionPreference = "Stop"

Write-Host "REZE - instalacja Chatterbox Multilingual V3" -ForegroundColor Cyan

$python = $null
try {
  py -3.11 --version | Out-Null
  $python = "py -3.11"
} catch {
  throw "Nie znaleziono Python 3.11. Zainstaluj Python 3.11 x64 i zaznacz py launcher."
}

if (-not (Test-Path ".venv-chatterbox")) {
  Write-Host "Tworzę środowisko .venv-chatterbox..."
  Invoke-Expression "$python -m venv .venv-chatterbox"
}

$venvPython = Join-Path $PWD ".venv-chatterbox\Scripts\python.exe"
Write-Host "Aktualizuję pip..."
& $venvPython -m pip install --upgrade pip setuptools wheel

Write-Host "Instaluję Chatterbox TTS. To może potrwać kilka minut..."
& $venvPython -m pip install chatterbox-tts

Write-Host ""
Write-Host "Gotowe." -ForegroundColor Green
Write-Host "Uruchom REZE, wybierz Chatterbox i kliknij 'Importuj WAV'."
Write-Host "Pierwsza synteza pobierze/załaduje model i będzie wyraźnie wolniejsza od kolejnych."
