# Synthetic prompts for the SELF-TEST of tools/voice-bench/web/compare.html (plumbing only, NOT a field result). Windows speech synthesis, 16 kHz mono WAV, one file per prompt id.
Add-Type -AssemblyName System.Speech
$root = Resolve-Path (Join-Path $PSScriptRoot '../../..'); $out = Join-Path $root 'data/local/voice-bench/field-selftest'; New-Item -ItemType Directory -Force $out | Out-Null
$prompts = (Get-Content (Join-Path $PSScriptRoot 'field-prompts.json') -Raw | ConvertFrom-Json).prompts
$long = 'Hello. The model is RB nine eighty H B. The minimum order quantity is one hundred pieces. For five hundred pieces the price is six dollars. We have black, white, blue and pink. The lead time is twenty five days after the deposit. Payment is thirty percent deposit and seventy percent before shipment. Can you put our logo on the cover? The carton has fifty pieces.'
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($p in $prompts) { $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft David Desktop'); $s.Rate = 0; $s.SetOutputToWaveFile((Join-Path $out ($p.id + '.wav')), $fmt); $text = if ($p.say) { $p.say } else { $long }; $s.Speak($text); $s.Dispose() }
Write-Output "ok: $($prompts.Count) files in $out"
