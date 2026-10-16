# Breadee 1.0.36 — ONE-CLICK isolated in-app updater test (throwaway Windows VM ONLY).
# SELF-CONTAINED: this kit already includes the unmodified prod 1.0.35 installer and the exact
# signed 1.0.36 candidate (+ .sig). Just unzip the kit on a DISPOSABLE VM and run this script
# from inside the unzipped folder — it auto-finds the installers beside it.
#
# It automates EVERYTHING locally and isolated (integrity check, cert, hosts, local HTTPS endpoint,
# install of unmodified prod 1.0.35). It changes nothing outside this throwaway VM and touches no
# global/production update channel.
#
# Your ONLY manual actions after running this:
#   (1) sign in with your APPROVED SUPPORT TEST ACCOUNT only (never a real owner/production login),
#   (2) Settings -> About -> Check for updates -> Install -> Relaunch,
#   (3) confirm About shows 1.0.36 and that $env:TEMP\breadee_qa_test\access.log recorded the .exe GET.
#
# RUN AS ADMINISTRATOR on a DISPOSABLE VM only:
#   powershell -ExecutionPolicy Bypass -File .\qa_oneclick_test.ps1
# (Optional overrides: -Installer135 / -Exe136 / -Sig136 to point elsewhere.)
param(
  [string]$Installer135 = (Join-Path $PSScriptRoot 'Breadee_1.0.35_x64-setup.exe'),
  [string]$Exe136       = (Join-Path $PSScriptRoot 'Breadee_1.0.36_x64-setup.exe'),
  [string]$Sig136       = (Join-Path $PSScriptRoot 'Breadee_1.0.36_x64-setup.exe.sig')
)
$ErrorActionPreference='Stop'

Write-Host "0/7 Verifying this is a throwaway VM and the bundled files are present + intact..."
foreach ($f in @($Installer135,$Exe136,$Sig136)) {
  if (-not (Test-Path $f)) { throw "Missing required file: $f  (run this script from inside the unzipped kit folder)" }
}
# Integrity: check the two installers against the kit's SHA256SUMS.txt (fail closed on mismatch).
$sumsFile = Join-Path $PSScriptRoot 'SHA256SUMS.txt'
if (Test-Path $sumsFile) {
  $sums = @{}
  Get-Content $sumsFile | ForEach-Object { if ($_ -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') { $sums[$Matches[2]] = $Matches[1].ToLower() } }
  foreach ($pair in @(@($Installer135,'Breadee_1.0.35_x64-setup.exe'), @($Exe136,'Breadee_1.0.36_x64-setup.exe'))) {
    $want = $sums[$pair[1]]
    if ($want) {
      $got = (Get-FileHash $pair[0] -Algorithm SHA256).Hash.ToLower()
      if ($got -ne $want) { throw "Integrity FAIL for $($pair[1]): expected $want got $got" }
      Write-Host "   OK integrity $($pair[1]) = $got"
    }
  }
} else { Write-Warning "SHA256SUMS.txt not found beside script — skipping integrity check." }

$HOSTNAME='raw.githubusercontent.com'
$CHANNEL='sitesupapp/Breadee-Desktop/desktop-production-channel'
$root="$env:TEMP\breadee_qa_test"
$serve="$root\serve\$CHANNEL"
New-Item -ItemType Directory -Force $serve | Out-Null

Write-Host "1/7 Building the ISOLATED QA manifest with the real verified signature..."
$sig = (Get-Content $Sig136 -Raw).Trim()
Copy-Item $Exe136 "$serve\Breadee_1.0.36_x64-setup.exe" -Force
$manifest = [ordered]@{
  version='1.0.36'; notes='QA isolated updater test'; pub_date='2026-10-16T08:37:45Z'
  platforms=@{ 'windows-x86_64'=@{ signature=$sig; url="https://$HOSTNAME/$CHANNEL/Breadee_1.0.36_x64-setup.exe" } }
}
($manifest | ConvertTo-Json -Depth 6) | Set-Content "$serve\latest.json" -Encoding utf8

Write-Host "2/7 Trusted self-signed cert for $HOSTNAME (LOCAL VM trust store only)..."
$cert = New-SelfSignedCertificate -DnsName $HOSTNAME -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddDays(2)
$pw = ConvertTo-SecureString 'qa' -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath "$root\c.pfx" -Password $pw | Out-Null
Export-Certificate  -Cert $cert -FilePath "$root\c.cer" | Out-Null
Import-Certificate -FilePath "$root\c.cer" -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
$openssl = "$env:ProgramFiles\Git\usr\bin\openssl.exe"
& $openssl pkcs12 -in "$root\c.pfx" -nocerts -nodes -passin pass:qa -out "$root\key.pem"
& $openssl pkcs12 -in "$root\c.pfx" -clcerts -nokeys  -passin pass:qa -out "$root\crt.pem"

Write-Host "3/7 Starting local HTTPS endpoint on 443 (logs to $root\access.log)..."
@"
import http.server, ssl, functools, datetime
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self,f,*a): open(r'$root\access.log','a').write(datetime.datetime.utcnow().isoformat()+' '+(f%a)+'\n')
h=functools.partial(H,directory=r'$root\serve')
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(r'$root\crt.pem',r'$root\key.pem')
s=http.server.HTTPServer(('127.0.0.1',443),h); s.socket=ctx.wrap_socket(s.socket,server_side=True); s.serve_forever()
"@ | Set-Content "$root\serve.py" -Encoding utf8
Start-Process python -ArgumentList "`"$root\serve.py`"" -WindowStyle Hidden
Start-Sleep 3

Write-Host "4/7 Redirecting $HOSTNAME -> 127.0.0.1 (hosts, LOCAL VM only)..."
$hosts="$env:windir\System32\drivers\etc\hosts"
if (-not (Select-String -Path $hosts -Pattern $HOSTNAME -Quiet)) { Add-Content $hosts "`n127.0.0.1 $HOSTNAME" }
try { $t=(Invoke-WebRequest -UseBasicParsing "https://$HOSTNAME/$CHANNEL/latest.json").Content; Write-Host "   endpoint OK: served version $(($t|ConvertFrom-Json).version)" } catch { Write-Warning "endpoint self-test: $($_.Exception.Message)" }

Write-Host "5/7 Installing the UNMODIFIED production 1.0.35..."
Start-Process $Installer135 -ArgumentList '/S' -Wait
Start-Sleep 4
$app = Get-ChildItem "$env:LOCALAPPDATA","$env:ProgramFiles","${env:ProgramFiles(x86)}" -Recurse -Filter '*.exe' -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -match 'Breadee' -and $_.FullName -notmatch 'setup' } | Select-Object -First 1
if ($app) { Write-Host "   installed: $($app.FullName)  (v$((Get-Item $app.FullName).VersionInfo.FileVersion))"; Start-Process $app.FullName }

Write-Host "`n6/7 READY. The Breadee app is open on an ISOLATED machine."
Write-Host "    >>> YOUR STEPS:"
Write-Host "        (1) Sign in with your APPROVED SUPPORT TEST ACCOUNT ONLY (never a real/production owner login)."
Write-Host "        (2) Settings -> About -> Check for updates -> Install -> Relaunch."
Write-Host "    It will upgrade IN-APP to 1.0.36. This is the only thing that counts as a PASS:"
Write-Host "        - About shows 1.0.36 after relaunch, AND"
Write-Host "        - $root\access.log shows a GET for Breadee_1.0.36_x64-setup.exe (the .exe DOWNLOAD, not just latest.json)."
Write-Host "    A latest.json fetch alone is NOT a pass."
Write-Host "`n7/7 CLEANUP when done (or just destroy the VM):"
Write-Host "      (Get-Content '$hosts') -notmatch '$HOSTNAME' | Set-Content '$hosts'"
Write-Host "      Get-ChildItem Cert:\LocalMachine\Root | ? { `$_.Subject -match '$HOSTNAME' } | Remove-Item -Force"
Write-Host "      Remove-Item -Recurse -Force '$root'"
