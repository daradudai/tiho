<#
  Tiho Engine launcher (Windows PowerShell 5.1+ / PowerShell 7).

  First run creates engine\.venv and installs the engine (uv if available, else venv+pip).
  All arguments are passed to `python -m tiho_engine`:

    .\start.ps1                                    # start llama-server + Clef-Flash (downloads if missing)
    .\start.ps1 --quant Q4_K_M                     # 8-12 GB cards
    .\start.ps1 --attach http://127.0.0.1:7378     # reuse a llama-server you already run
    .\start.ps1 --download-only                    # just fetch model + llama.cpp
    .\start.ps1 --help
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here '.venv'
$py = Join-Path $venv 'Scripts\python.exe'

function Find-Python {
    # probes may write to stderr; under 'Stop' Windows PowerShell 5.1 would turn that into an exception
    $ErrorActionPreference = 'Continue'
    foreach ($cand in @('python', 'py', 'python3')) {
        $cmd = Get-Command $cand -ErrorAction SilentlyContinue
        if ($cmd) {
            & $cmd.Source -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) { return $cmd.Source }
        }
    }
    throw 'Python 3.10+ not found. Install it from https://www.python.org/downloads/ (tick "Add to PATH").'
}

if (-not (Test-Path $py)) {
    $sys = Find-Python
    Write-Host "[tiho-engine] creating $venv ..."
    $ErrorActionPreference = 'Continue'
    & $sys -m uv --version 2>$null | Out-Null
    $haveUv = ($LASTEXITCODE -eq 0)
    if ($haveUv) {
        & $sys -m uv venv $venv --quiet
        & $sys -m uv pip install --quiet --python $py -e $here
    } else {
        & $sys -m venv $venv
        & $py -m pip install --quiet --upgrade pip
        & $py -m pip install --quiet -e $here
    }
    if ($LASTEXITCODE -ne 0) { throw 'installing tiho-engine failed' }
}

& $py -m tiho_engine @args
exit $LASTEXITCODE
