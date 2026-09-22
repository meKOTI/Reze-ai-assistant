$ErrorActionPreference = 'Stop'
Write-Host 'REZE - konfiguracja adaptacyjnego lokalnego AI' -ForegroundColor Cyan

$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
  Write-Host ''
  Write-Host 'Nie znaleziono Ollama.' -ForegroundColor Yellow
  Write-Host 'Zainstaluj Ollama dla Windows, uruchom ją, a potem odpal ten skrypt ponownie.'
  exit 1
}

Write-Host 'Ollama znaleziona.' -ForegroundColor Green
Write-Host 'Pobieram lekki model qwen3:1.7b...'
ollama pull qwen3:1.7b
Write-Host 'Pobieram glowny model qwen3:4b...'
ollama pull qwen3:4b

Write-Host ''
Write-Host 'Gotowe. Tryb AUTO wybierze 4B, a przy presji RAM/VRAM przejdzie na 1.7B.' -ForegroundColor Green
Write-Host 'Uruchom REZE przez npm run dev.'
