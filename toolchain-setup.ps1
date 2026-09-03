$ErrorActionPreference = 'Stop'
$tc = 'C:\Users\Administrator\.dsh\android-toolchain'
Set-Location $tc

Write-Output '== extracting jdk =='
Expand-Archive -Path "$tc\jdk17.zip" -DestinationPath "$tc\_jdkx" -Force
$jdkInner = Get-ChildItem "$tc\_jdkx" -Directory | Select-Object -First 1
Move-Item $jdkInner.FullName "$tc\jdk" -Force
Write-Output ("jdk at: " + (Get-ChildItem "$tc\jdk" | Select-Object -First 1).FullName)

Write-Output '== extracting gradle =='
Expand-Archive -Path "$tc\gradle.zip" -DestinationPath "$tc\gradle" -Force
Write-Output ("gradle dirs: " + ((Get-ChildItem "$tc\gradle" -Directory | Select-Object -ExpandProperty Name) -join ', '))

Write-Output '== extracting cmdline-tools =='
Expand-Archive -Path "$tc\cmdline-tools.zip" -DestinationPath "$tc\_cmdx" -Force
New-Item -ItemType Directory -Force -Path "$tc\android-sdk\cmdline-tools" | Out-Null
Move-Item "$tc\_cmdx\cmdline-tools" "$tc\android-sdk\cmdline-tools\latest" -Force
$sdkRoot = "$tc\android-sdk"
$sdkMgr = "$sdkRoot\cmdline-tools\latest\bin\sdkmanager.bat"
$env:JAVA_HOME = "$tc\jdk"
$env:PATH = "$tc\jdk\bin;$env:PATH"

Write-Output '== accepting licenses =='
cmd /c "echo y | `"$sdkMgr`" --sdk_root=$sdkRoot --licenses > `"$tc\licenses.log`" 2>&1"
Write-Output ("licenses done, exit=" + $LASTEXITCODE)

Write-Output '== installing platform-tools / platform android-35 / build-tools 35.0.0 =='
cmd /c "`"$sdkMgr`" --sdk_root=$sdkRoot `"platform-tools`" `"platforms;android-35`" `"build-tools;35.0.0`" > `"$tc\sdk-install.log`" 2>&1"
Write-Output ("sdk install done, exit=" + $LASTEXITCODE)

Write-Output '== verification =='
Write-Output ("platform-tools adb exists: " + (Test-Path "$sdkRoot\platform-tools\adb.exe"))
Write-Output ("platform android-35 exists: " + (Test-Path "$sdkRoot\platforms\android-35"))
Write-Output ("build-tools exists: " + (Test-Path "$sdkRoot\build-tools\35.0.0\aapt2.exe"))
Write-Output ("java version: " + (& "$tc\jdk\bin\java.exe" -version 2>&1 | Select-Object -First 1))
