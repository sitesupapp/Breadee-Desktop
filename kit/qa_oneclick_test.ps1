# Breadee 1.0.36 — ONE-CLICK isolated in-app updater test (throwaway Windows VM ONLY).
# Automates EVERYTHING (cert, hosts, local HTTPS endpoint, install of unmodified prod 1.0.35).
# Your ONLY manual actions after running this: (1) log in, (2) click Check for Updates -> Install.
#
# PREREQ (download both via your browser, once):
#   -Installer135 : Breadee_1.0.35_x64-setup.exe  (from release desktop-prod-v1.0.35)
#   -Exe136       : Breadee_1.0.36_x64-setup.exe   (from the signed artifact)
#   -Sig136       : Breadee_1.0.36_x64-setup.exe.sig (same artifact)
# Artifact: https://github.com/sitesupapp/Breadee-Desktop/actions/runs/38817031890/artifacts/12034797863
#
# RUN AS ADMINISTRATOR on a DISPOSABLE VM only:
#   powershell -ExecutionPolicy Bypass -File qa_oneclick_test.ps1 -Installer135 .\Breadee_1.0.35_x64-setup.exe -Exe136 .\Breadee_1.0.36_x64-setup.exe -Sig136 .\Breadee_1.0.36_x64-setup.exe.sig
param(
  [Parameter(Mandatory=$true)][string]$Installer135,
  [Parameter(Mandatory=$true)][string]$Exe136,
  [Parameter(Mandatory=$true)][string]$Sig136
)
$ErrorActionPreference='Stop'
$HOSTNAME='raw.githubusercontent.com'
$CHANNEL='sitesupapp/Breadee-Desktop/desktop-production-channel'
$root="$env:TEMP\breadee_qa_test"
$serve="$root\serve\$CHANNEL"
New-Item -ItemType Directory -Force $serve | Out-Null

Write-Host "1/6 Building QA manifest with the real verified signature..."
$sig = (Get-Content $Sig136 -Raw).Trim()
Copy-Item $Exe136 "$serve\Breadee_1.0.36_x64-setup.exe" -Force
$manifest = [ordered]@{
  version='1.0.36'; notes='QA isolated updater test'; pub_date='2026-10-16T08:37:45Z'
  platforms=@{ 'windows-x86_64'=@{ signature=$sig; url="https://$HOSTNAME/$CHANNEL/Breadee_1.0.36_x64-setup.exe" } }
}
($manifest | ConvertTo-Json -Depth 6) | Set-Content "$serve\latest.json" -Encoding utf8

Write-Host "2/6 Trusted self-signed cert for $HOSTNAME..."
$cert = New-SelfSignedCertificate -DnsName $HOSTNAME -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddDays(2)
$pw = ConvertTo-SecureString 'qa' -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath "$root\c.pfx" -Password $pw | Out-Null
Export-Certificate  -Cert $cert -FilePath "$root\c.cer" | Out-Null
Import-Certificate -FilePath "$root\c.cer" -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
$openssl = "$env:ProgramFiles\Git\usr\bin\openssl.exe"
& $openssl pkcs12 -in "$root\c.pfx" -nocerts -nodes -passin pass:qa -out "$root\key.pem"
& $openssl pkcs12 -in "$root\c.pfx" -clcerts -nokeys  -passin pass:qa -out "$root\crt.pem"

Write-Host "3/6 Starting local HTTPS endpoint on 443 (logs to $root\access.log)..."
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

Write-Host "4/6 Redirecting $HOSTNAME -> 127.0.0.1 (hosts)..."
$hosts="$env:windir\System32\drivers\etc\hosts"
if (-not (Select-String -Path $hosts -Pattern $HOSTNAME -Quiet)) { Add-Content $hosts "`n127.0.0.1 $HOSTNAME" }
try { $t=(Invoke-WebRequest -UseBasicParsing "https://$HOSTNAME/$CHANNEL/latest.json").Content; Write-Host "   endpoint OK: served version $(($t|ConvertFrom-Json).version)" } catch { Write-Warning "endpoint self-test: $($_.Exception.Message)" }

Write-Host "5/6 Installing the UNMODIFIED production 1.0.35..."
Start-Process $Installer135 -ArgumentList '/S' -Wait
Start-Sleep 4
$app = Get-ChildItem "$env:LOCALAPPDATA","$env:ProgramFiles","${env:ProgramFiles(x86)}" -Recurse -Filter '*.exe' -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -match 'Breadee' -and $_.FullName -notmatch 'setup' } | Select-Object -First 1
if ($app) { Write-Host "   installed: $($app.FullName)  (v$((Get-Item $app.FullName).VersionInfo.FileVersion))"; Start-Process $app.FullName }

Write-Host "`n6/6 READY. The Breadee app is open on an ISOLATED machine."
Write-Host "    >>> YOUR ONLY STEPS:  (1) Sign in.  (2) Settings -> About -> Check for updates -> Install -> Relaunch."
Write-Host "    It will upgrade in-app to 1.0.36. Confirm About shows 1.0.36; the local $root\access.log will show the .exe download."
Write-Host "`n    CLEANUP when done (destroy the VM, or run):"
Write-Host "      (Get-Content '$hosts') -notmatch '$HOSTNAME' | Set-Content '$hosts'"
Write-Host "      Get-ChildItem Cert:\LocalMachine\Root | ? { `$_.Subject -match '$HOSTNAME' } | Remove-Item -Force"
