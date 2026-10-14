# LAB corpus: renders utterances.json with the Windows text-to-speech voices (David = owner, Zira = supplier) to 16 kHz mono 16-bit WAV files. Run: powershell -File tools/voice-bench/corpus/make-corpus.ps1
Add-Type -AssemblyName System.Speech
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$out = Join-Path $root 'data\local\voice-bench\corpus\clean'; New-Item -ItemType Directory -Force $out | Out-Null
$j = Get-Content (Join-Path $PSScriptRoot 'utterances.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$items = @($j.items) + @($j.scenarioB)
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($it in $items) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($(if ($it.who -eq 'owner') { 'Microsoft David Desktop' } else { 'Microsoft Zira Desktop' }))
  $s.Rate = 0
  $f = Join-Path $out ($it.id + '.wav'); $s.SetOutputToWaveFile($f, $fmt); $s.Speak($it.spoken); $s.Dispose()
  '{0} {1} bytes' -f $it.id, (Get-Item $f).Length
}
