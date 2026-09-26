set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

root := justfile_directory()
coop_mod := root + "/mods/coop"
# NOTE: not under build/ — the gulp build wipes build/ at the start
coop_asar := root + "/dist-mods/coop.asar"

default:
    @just --list

# Install all dependencies (root game + electron shell)
install:
    npm install
    npm install --prefix electron

# Verify build prerequisites (node, ffmpeg for audio, java for the texture packer)
check:
    @node --version; npm --version; \
    Get-Command ffmpeg -ErrorAction Stop | Out-Null; Write-Host "ffmpeg OK"; \
    Get-Command java -ErrorAction Stop | Out-Null; Write-Host "java OK"; \
    Write-Host "prerequisites OK"

# Run the game in dev mode (devtools open) with the co-op mod loaded
dev:
    $gulp = Start-Process powershell -ArgumentList "-NoLogo","-Command","npm run gulp" -WorkingDirectory "{{root}}" -PassThru; \
    $code = 1; \
    try { \
        $up = $false; \
        for ($i = 0; $i -lt 240 -and -not $up; $i++) { \
            try { $c = New-Object Net.Sockets.TcpClient("127.0.0.1", 3005); $c.Close(); $up = $true } catch { Start-Sleep -Milliseconds 500 } \
        }; \
        if (-not $up) { throw "dev server did not come up on :3005" }; \
        Push-Location "{{root}}/electron"; npm start -- --dev --load-mod "{{coop_mod}}" --watch; $code = $LASTEXITCODE; Pop-Location \
    } finally { taskkill /PID $gulp.Id /T /F >$null 2>&1 } \
    if ($code -ne 0) { throw "electron exited with code $code" }

# Run the game with the co-op mod loaded (no devtools)
run:
    $gulp = Start-Process powershell -ArgumentList "-NoLogo","-Command","npm run gulp" -WorkingDirectory "{{root}}" -PassThru; \
    $code = 1; \
    try { \
        $up = $false; \
        for ($i = 0; $i -lt 240 -and -not $up; $i++) { \
            try { $c = New-Object Net.Sockets.TcpClient("127.0.0.1", 3005); $c.Close(); $up = $true } catch { Start-Sleep -Milliseconds 500 } \
        }; \
        if (-not $up) { throw "dev server did not come up on :3005" }; \
        Push-Location "{{root}}/electron"; npm start -- --load-mod "{{coop_mod}}"; $code = $LASTEXITCODE; Pop-Location \
    } finally { taskkill /PID $gulp.Id /T /F >$null 2>&1 } \
    if ($code -ne 0) { throw "electron exited with code $code" }

# Pack the co-op mod into a distributable .asar bundle
mod:
    $ErrorActionPreference = "Stop"; \
    New-Item -ItemType Directory -Force "{{root}}/dist-mods" | Out-Null; \
    node "{{root}}/node_modules/@electron/asar/bin/asar.js" pack "{{coop_mod}}" "{{coop_asar}}"; \
    if ($LASTEXITCODE -ne 0) { throw "asar pack failed" }; \
    node "{{root}}/node_modules/@electron/asar/bin/asar.js" list "{{coop_asar}}"; \
    if ($LASTEXITCODE -ne 0) { throw "asar list failed" }

# Build a distributable app bundle with the co-op mod included (takes a while)
package platform="win32" arch="x64": mod
    $ErrorActionPreference = "Stop"; \
    npm run package-{{platform}}-{{arch}}; \
    if ($LASTEXITCODE -ne 0) { throw "package build failed" }; \
    $app = "{{root}}/build_output/standalone/shapez-{{platform}}-{{arch}}"; \
    if (-not (Test-Path $app)) { throw "expected package dir missing: $app" }; \
    if (-not (Test-Path "{{coop_asar}}")) { throw "co-op mod bundle missing: {{coop_asar}}" }; \
    New-Item -ItemType Directory -Force "$app/mods" | Out-Null; \
    Copy-Item "{{coop_asar}}" "$app/mods/coop.asar" -Force; \
    Write-Host "bundled co-op mod into $app/mods/coop.asar"

# Inject the co-op mod into an already-built package and re-zip (no rebuild)
rebundle platform="win32" arch="x64": mod
    $ErrorActionPreference = "Stop"; \
    $app = "{{root}}/build_output/standalone/shapez-{{platform}}-{{arch}}"; \
    if (-not (Test-Path $app)) { throw "no existing package at $app — run just package first" }; \
    New-Item -ItemType Directory -Force "$app/mods" | Out-Null; \
    Copy-Item "{{coop_asar}}" "$app/mods/coop.asar" -Force; \
    $zip = "{{root}}/build_output/shapez-coop-{{platform}}-{{arch}}.zip"; \
    if (Test-Path $zip) { Remove-Item $zip -Force }; \
    Add-Type -AssemblyName System.IO.Compression.FileSystem; \
    [System.IO.Compression.ZipFile]::CreateFromDirectory($app, $zip); \
    $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1); \
    Write-Host "rebuilt: $zip ($mb MB)"

# Build + zip a ready-to-send co-op bundle: `just export` (Windows friend) or `just export linux x64`
export platform="win32" arch="x64": (package platform arch)
    $ErrorActionPreference = "Stop"; \
    $app = "{{root}}/build_output/standalone/shapez-{{platform}}-{{arch}}"; \
    $zip = "{{root}}/build_output/shapez-coop-{{platform}}-{{arch}}.zip"; \
    if (Test-Path $zip) { Remove-Item $zip -Force }; \
    Add-Type -AssemblyName System.IO.Compression.FileSystem; \
    [System.IO.Compression.ZipFile]::CreateFromDirectory($app, $zip); \
    $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1); \
    Write-Host ""; Write-Host "Ready to send: $zip ($mb MB)"; \
    Write-Host "Friend instructions: extract, run shapezio, allow the firewall prompt on the host, then Host and share the invite code."

# Typecheck + lint the co-op code (main process + mod)
lint:
    node "{{root}}/electron/node_modules/typescript/bin/tsc" --noEmit -p "{{root}}/electron"; \
    if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }; \
    node "{{root}}/node_modules/eslint/bin/eslint.js" mods/coop/entry.js electron/src/coop/; \
    if ($LASTEXITCODE -ne 0) { throw "eslint failed" }; \
    Write-Host "lint OK"

# Tail the co-op log file the game writes (%APPDATA%/shapez-ce/coop.log)
logs lines="50":
    $log = "$env:APPDATA/shapez-ce/coop.log"; \
    if (-not (Test-Path $log)) { throw "no co-op log yet at $log (host or join a game first)" }; \
    Get-Content $log -Tail {{lines}}

# Remove build outputs
clean:
    Remove-Item -Recurse -Force "{{root}}/build" -ErrorAction SilentlyContinue; \
    Remove-Item -Recurse -Force "{{root}}/build_output" -ErrorAction SilentlyContinue; \
    Remove-Item -Recurse -Force "{{root}}/dist-mods" -ErrorAction SilentlyContinue; \
    Remove-Item -Recurse -Force "{{root}}/res_built" -ErrorAction SilentlyContinue; \
    Remove-Item -Recurse -Force "{{root}}/electron/dist" -ErrorAction SilentlyContinue
