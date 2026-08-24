@echo off
setlocal
cd /d "%~dp0"
title Sthang Studio - Local Timing Setup

REM Force UTF-8 mode for legacy Python package setup scripts on Windows and
REM prefer wheels whenever they are available. This avoids locale-dependent
REM source-build failures on clean PCs.
set "PYTHONUTF8=1"
set "PIP_PREFER_BINARY=1"

echo.
echo === Sthang Studio local timing setup ===
echo Primary: KFA Khmer Forced Aligner ^(local CPU / ONNX^)
echo Fallback: faster-whisper ^(local CPU/GPU^)
echo Google Cloud Speech-to-Text is NOT configured or called.
echo.

if exist ".venv\Scripts\python.exe" goto :install

where py >nul 2>nul
if not errorlevel 1 goto :create_with_py
where python >nul 2>nul
if not errorlevel 1 goto :create_with_python
goto :python_error

:create_with_py
py -3.12 -c "import sys" >nul 2>nul
if not errorlevel 1 (
  echo Creating .venv with Python 3.12...
  py -3.12 -m venv ".venv"
  goto :venv_done
)
py -3.11 -c "import sys" >nul 2>nul
if not errorlevel 1 (
  echo Creating .venv with Python 3.11...
  py -3.11 -m venv ".venv"
  goto :venv_done
)
echo Creating .venv with your default Python...
py -3 -m venv ".venv"
goto :venv_done

:create_with_python
echo Creating .venv with python...
python -m venv ".venv"
goto :venv_done

:venv_done
if errorlevel 1 goto :python_error

:install
echo.
echo Python environment:
".venv\Scripts\python.exe" --version
if errorlevel 1 goto :python_error

echo.
echo Checking whether the working local timing environment is already ready...
".venv\Scripts\python.exe" -c "import importlib.util, os; from importlib.metadata import version; base=os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'); model=os.path.join(base,'kfa','wav2vec2-km-base-1500.onnx'); assert all(importlib.util.find_spec(x) for x in ['kfa','khmercut','faster_whisper','onnxruntime','khmernormalizer']); assert version('khmercut')=='0.0.2'; assert version('python-crfsuite')=='0.9.9'; assert version('tqdm')=='4.65.0'; assert version('sosap')=='0.4.3'; assert os.path.exists(model); print('KFA + Whisper timing environment already READY')" >nul 2>nul
if not errorlevel 1 goto :already_ready

echo.
echo Updating pip...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :pip_error

set KFA_OK=1
echo.
echo Installing KFA Khmer forced-aligner dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade setuptools wheel
if errorlevel 1 goto :pip_error
".venv\Scripts\python.exe" -m pip install --prefer-binary -r "local-timing\requirements-kfa.txt"
if errorlevel 1 (
  set KFA_OK=0
  echo.
  echo WARNING: KFA dependency installation did not complete on this Python environment.
) else (
  echo Installing KFA 0.2.0 itself without legacy dependency resolution...
  ".venv\Scripts\python.exe" -m pip install --prefer-binary --no-deps "kfa==0.2.0"
  if errorlevel 1 set KFA_OK=0
)

echo.
echo Installing local Whisper fallback...
".venv\Scripts\python.exe" -m pip install --prefer-binary -r "local-timing\requirements-whisper.txt"
if errorlevel 1 goto :pip_error

echo.
echo Checking local timing environment...
".venv\Scripts\python.exe" -c "import importlib.util; assert importlib.util.find_spec('faster_whisper'); import onnxruntime; print('ONNX Runtime: OK'); print('Whisper fallback: OK')"
if errorlevel 1 goto :pip_error

REM KFA 0.2.0's published wheel metadata still declares sosap==0.0.1, but that
REM release has no Windows/Python 3.12 wheel. Sthang Studio uses the compatible
REM sosap 0.4.3 Windows wheel. Allow only that known metadata mismatch; fail on
REM every other pip dependency error.
".venv\Scripts\python.exe" -c "import subprocess,sys; p=subprocess.run([sys.executable,'-m','pip','check'],capture_output=True,text=True); lines=[x.strip() for x in (p.stdout+'\n'+p.stderr).splitlines() if x.strip()]; unexpected=[x for x in lines if not ('kfa 0.2.0 has requirement sosap==0.0.1' in x.lower() and 'sosap 0.4.3' in x.lower())]; print('Dependency check: OK (known KFA sosap metadata mismatch accepted).') if not unexpected else print('\n'.join(unexpected)); sys.exit(1 if unexpected else 0)"
if errorlevel 1 goto :pip_error

if "%KFA_OK%"=="1" (
  echo.
  echo Verifying KFA and preloading its Khmer ONNX model...
  echo The first setup may download about 360 MB once.
  ".venv\Scripts\python.exe" -c "from importlib.metadata import version; import kfa, khmercut, khmernormalizer; from khmercut import tokenize; from sosap import Model; assert version('khmercut')=='0.0.2'; assert version('python-crfsuite')=='0.9.9'; assert version('tqdm')=='4.65.0'; assert version('sosap')=='0.4.3'; assert callable(tokenize); assert Model is not None; print('KFA package, Khmer tokenizer, and model cache: READY')"
  if errorlevel 1 set KFA_OK=0
)

echo.
echo ============================================================
echo Local timing setup complete.
if "%KFA_OK%"=="1" (
  echo Primary KFA package + Khmer model: READY
) else (
  echo Primary KFA package: NEEDS REPAIR
  echo The app can still run with its local Whisper fallback.
)
echo Whisper fallback: READY
echo.
echo No Google Cloud Speech-to-Text billing is involved.
echo ============================================================
if not "%KCS_NONINTERACTIVE%"=="1" pause
exit /b 0

:already_ready
echo.
echo ============================================================
echo Existing local timing environment is READY.
echo No Python packages were changed.
echo KFA: READY
echo Whisper fallback: READY
echo Google Cloud Speech-to-Text: NOT USED
echo ============================================================
if not "%KCS_NONINTERACTIVE%"=="1" pause
exit /b 0

:python_error
echo.
echo ERROR: A usable Python installation was not found or venv creation failed.
echo Python 3.11 or 3.12 64-bit is recommended for the smoothest setup.
echo Install Python, then run this file again.
if not "%KCS_NONINTERACTIVE%"=="1" pause
exit /b 1

:pip_error
echo.
echo ERROR: Local timing dependency setup failed.
echo Copy the error above and send it to ChatGPT.
if not "%KCS_NONINTERACTIVE%"=="1" pause
exit /b 1
